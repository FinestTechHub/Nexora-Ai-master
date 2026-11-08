import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run promote-admin -- user@example.com');
  process.exit(1);
}

const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'creatorforge.sqlite'));
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}. Start the app and create the intended account first.`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
try {
  const user = db.prepare('SELECT id,email,role FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No account found for ${email}. The user must register before promotion.`);
    process.exitCode = 1;
  } else if (user.role === 'admin') {
    console.log(`${email} is already an admin.`);
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const confirmation = await rl.question(`Promote ${email} to ADMIN on database ${dbPath}? Type the email to confirm: `);
      if (confirmation.trim().toLowerCase() !== email) {
        console.log('Cancelled. No account changes were made.');
      } else {
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
        console.log(`Promoted ${email} to admin. Sign out and sign back in for the new role to appear in the session.`);
      }
    } finally {
      rl.close();
    }
  }
} finally {
  db.close();
}
