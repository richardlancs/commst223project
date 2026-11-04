import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || path.join(process.cwd(), 'data', 'referral-rush.db');
if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const { server, lanAddresses } = createApp({ dbFile });
server.listen(port, '0.0.0.0', () => {
  console.log(`The Referral Rush is running on port ${port}.`);
  console.log(`  This computer:  http://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  Same Wi-Fi:     http://${ip}:${port}`);
});
