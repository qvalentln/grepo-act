import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import cron from 'node-cron';
import axios from 'axios';
import zlib from 'zlib';
import pg from 'pg';

const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Helper: Download and parse gz CSV file
async function fetchGrepoData(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  const text = zlib.gunzipSync(res.data).toString('utf-8');
  return text.trim().split('\n').filter(Boolean).map(row => row.split(','));
}

// Database Upsert & Diff Logic
async function syncAndTrack(worldId) {
  const baseUrl = `https://${worldId}.grepolis.com/data`;

  const [playersRaw, attRaw, defRaw, allyRaw] = await Promise.all([
    fetchGrepoData(`${baseUrl}/players.txt.gz`),
    fetchGrepoData(`${baseUrl}/player_kills_att.txt.gz`),
    fetchGrepoData(`${baseUrl}/player_kills_def.txt.gz`),
    fetchGrepoData(`${baseUrl}/alliances.txt.gz`)
  ]);

  // 1. Sync Alliances Table and build cache map
  const alliances = new Map();
  const allyQuery = `
    INSERT INTO alliances (alliance_id, name)
    VALUES ($1, $2)
    ON CONFLICT (alliance_id) DO UPDATE SET name = EXCLUDED.name;
  `;

  for (const row of allyRaw) {
    const allianceId = parseInt(row[0], 10);
    const allianceName = decodeURIComponent(row[1].replace(/\+/g, ' '));
    alliances.set(allianceId, allianceName);
    await db.query(allyQuery, [allianceId, allianceName]);
  }

  // 2. Build fast lookup maps for Battle Points
  const abpMap = new Map(attRaw.map(a => [parseInt(a[1], 10), parseInt(a[2], 10) || 0]));
  const dbpMap = new Map(defRaw.map(d => [parseInt(d[1], 10), parseInt(d[2], 10) || 0]));

  // 3. Upsert Players
  const playerQuery = `
    INSERT INTO players (player_id, name, alliance_id, points, abp, dbp, inactive_hours, was_inactive, last_updated)
    VALUES ($1, $2, $3, $4, $5, $6, 0, FALSE, NOW())
    ON CONFLICT (player_id) DO UPDATE SET
        name = EXCLUDED.name,
        alliance_id = EXCLUDED.alliance_id,
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
    RETURNING player_id, name, alliance_id, points, inactive_hours, was_inactive, (dbp - players.dbp) AS dbp_diff;
  `;

  const alerts = [];
  const BATCH_SIZE = 50; // Process 50 DB calls concurrently for speed

  for (let i = 0; i < playersRaw.length; i += BATCH_SIZE) {
    const batch = playersRaw.slice(i, i + BATCH_SIZE);
    
    const results = await Promise.all(
      batch.map(async (row) => {
        const playerId = parseInt(row[0], 10);
        const name = decodeURIComponent(row[1].replace(/\+/g, ' '));
        const allianceId = row[2] ? parseInt(row[2], 10) : null;
        const points = parseInt(row[3], 10) || 0;
        const abp = abpMap.get(playerId) || 0;
        const dbp = dbpMap.get(playerId) || 0;

        const res = await db.query(playerQuery, [playerId, name, allianceId, points, abp, dbp]);
        return res.rows[0];
      })
    );

    for (const state of results) {
      const allyName = alliances.get(state.alliance_id) ? `(${alliances.get(state.alliance_id)})` : '';

      // Alert 1: Woke up after being inactive for 6+ hours
      if (state.was_inactive) {
        alerts.push(`⏰ **${state.name}** ${allyName} · points or ABP moving again after ${state.inactive_hours} hours · ${state.points.toLocaleString()} pts`);
      }
      // Alert 2: Reached 6 hours of inactivity
      else if (state.inactive_hours === 6) {
        let msg = `😴 **${state.name}** ${allyName} · no points or ABP movement for 6 hours · ${state.points.toLocaleString()} pts`;
        if (state.dbp_diff > 0) msg += ' · DBP rising while they stand still';
        alerts.push(msg);
      }
    }
  }

  return alerts;
}

// Post messages safely respecting Discord's 2000-character limit
async function postToDiscord(alerts) {
  if (!alerts.length) return;
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel) return;

  let messageChunk = '';
  for (const alert of alerts) {
    if ((messageChunk + alert).length > 1900) {
      await channel.send(messageChunk);
      messageChunk = '';
    }
    messageChunk += alert + '\n';
  }

  if (messageChunk.length > 0) {
    await channel.send(messageChunk);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Runs every hour at minute 5 (e.g., 01:05, 02:05)
  cron.schedule('5 * * * *', async () => {
    try {
      console.log('Fetching world update...');
      const alerts = await syncAndTrack(process.env.GREPO_WORLD);
      await postToDiscord(alerts);
      console.log(`Hourly update posted. Alerts sent: ${alerts.length}`);
    } catch (err) {
      console.error('Error during hourly sync:', err);
    }
  });
});

client.login(process.env.DISCORD_TOKEN);