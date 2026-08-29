import 'dotenv/config';
import axios from 'axios';
import zlib from 'zlib';
import pg from 'pg';

const { Pool } = pg;


const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fetchGrepoData(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  const text = zlib.gunzipSync(res.data).toString('utf-8');
  return text.trim().split('\n').filter(Boolean).map(row => row.split(','));
}

async function run() {
  const worldId = process.env.GREPO_WORLD;
  if (!worldId) {
    throw new Error('GREPO_WORLD lipseste');
  }

  const baseUrl = `https://${worldId}.grepolis.com/data`;

  console.log(`Preluare date pentru lumea: ${worldId}...`);
  const [playersRawUnfiltered, attRaw, defRaw, allyRaw] = await Promise.all([
    fetchGrepoData(`${baseUrl}/players.txt.gz`),
    fetchGrepoData(`${baseUrl}/player_kills_att.txt.gz`),
    fetchGrepoData(`${baseUrl}/player_kills_def.txt.gz`),
    fetchGrepoData(`${baseUrl}/alliances.txt.gz`)
  ]);

  const playersRaw = playersRawUnfiltered.filter(row => (parseInt(row[3], 10) || 0) > 900);
  const alliances = new Map();
  const allyQuery = `
    INSERT INTO alliances (alliance_id, name)
    VALUES ($1, $2)
    ON CONFLICT (alliance_id) DO UPDATE SET name = EXCLUDED.name;
  `;

  await Promise.all(
    allyRaw.map(async (row) => {
      const allianceId = parseInt(row[0], 10);
      const allianceName = decodeURIComponent((row[1] || '').replace(/\+/g, ' '));
      if (!isNaN(allianceId)) {
        alliances.set(allianceId, allianceName);
        return db.query(allyQuery, [allianceId, allianceName]);
      }
    })
  );

 
  const abpMap = new Map(attRaw.map(a => [parseInt(a[1], 10), parseInt(a[2], 10) || 0]));
  const dbpMap = new Map(defRaw.map(d => [parseInt(d[1], 10), parseInt(d[2], 10) || 0]));

  
 const playerQuery = `
  INSERT INTO players (player_id, name, alliance_id, alliance_name, points, abp, dbp, inactive_hours, previous_inactive_hours, was_inactive, last_updated)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, FALSE, NOW())
  ON CONFLICT (player_id) DO UPDATE SET
      name = EXCLUDED.name,
      alliance_id = EXCLUDED.alliance_id,
      alliance_name = EXCLUDED.alliance_name,
      previous_inactive_hours = players.inactive_hours,
      inactive_hours = CASE 
          WHEN players.points = EXCLUDED.points AND players.abp = EXCLUDED.abp THEN players.inactive_hours + 1
          ELSE 0 
      END,
      was_inactive = CASE 
          WHEN (players.points != EXCLUDED.points OR players.abp != EXCLUDED.abp) AND players.inactive_hours >= 6 THEN TRUE
          ELSE FALSE
      END,
      points = EXCLUDED.points,
      abp = EXCLUDED.abp,
      dbp = EXCLUDED.dbp,
      last_updated = NOW()
  RETURNING 
      player_id, 
      name, 
      alliance_id, 
      alliance_name, 
      points, 
      previous_inactive_hours,
      inactive_hours, 
      was_inactive,
      (EXCLUDED.dbp - players.dbp) AS dbp_diff;
`;

  const alerts = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < playersRaw.length; i += BATCH_SIZE) {
    const batch = playersRaw.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        const playerId = parseInt(row[0], 10);
        const name = decodeURIComponent((row[1] || '').replace(/\+/g, ' '));
        const rawAlly = parseInt(row[2], 10);
        const allianceId = isNaN(rawAlly) || rawAlly === 0 ? null : rawAlly;
        const allianceName = allianceId ? (alliances.get(allianceId) || null) : null;
        const points = parseInt(row[3], 10) || 0;
        const abp = abpMap.get(playerId) || 0;
        const dbp = dbpMap.get(playerId) || 0;

        if (isNaN(playerId)) return null;

        const res = await db.query(playerQuery, [
          playerId,
          name,
          allianceId,
          allianceName,
          points,
          abp,
          dbp
        ]);
        return res.rows[0];
      })
    );

    for (const state of results) {
      if (!state) continue;
      const allyName = state.alliance_name ? `(${state.alliance_name})` : '';

     if (state.was_inactive) {
        alerts.push(`⏰ **${state.name}** ${allyName} · punctele sau ABP s-au miscat, a inviat mortaciunea dupa ${state.previous_inactive_hours} ore · ${state.points.toLocaleString()} pct`);
    }


     if(state.dbp_diff > 0) alerts.push(`🛡️ **${state.name}** ${allyName} · primește atacuri (+${state.dbp_diff.toLocaleString()} DBP) în timp ce este inactiv de ${state.inactive_hours} ore · ${state.points.toLocaleString()} pct`);
     else if (state.inactive_hours === 12) {
       alerts.push(`🫓 **${state.name}** ${allyName} · fara miscare de puncte sau ABP de 12 ore, chifla · ${state.points.toLocaleString()} pct`);
    }
      else if(state.inactive_hours === 6) {        
       alerts.push(`🛌 **${state.name}** ${allyName} · fara miscare de puncte sau ABP de 6 ore, dormeza de lux · ${state.points.toLocaleString()} pct`);
    }
  }
}


  if (alerts.length && process.env.DISCORD_WEBHOOK_URL) {
    let chunk = '';
    for (const alert of alerts) {
      if ((chunk + alert).length > 1900) {
        await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: chunk });
        chunk = '';
      }
      chunk += alert + '\n';
    }
    if (chunk.length > 0) {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: chunk });
    }
  }

  await db.end();
  console.log(`Sincronizare finalizata cu succes! Jucatori procesati: ${playersRaw.length}`);
}

run().catch(err => {
  console.error('Eroare executie:', err);
  process.exit(1);
});
