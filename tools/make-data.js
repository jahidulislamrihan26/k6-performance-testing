// Writes data/users.json: the test shoppers that exist in the demo shop (same rule as sut/server.js).
const fs = require('fs');
const path = require('path');
const n = Number(process.argv[2] || 100);
const users = Array.from({ length: n }, (_, i) => ({ email: `user${i + 1}@shop.test`, password: `Passw0rd!${i + 1}` }));
fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'data', 'users.json'), JSON.stringify(users, null, 1) + '\n');
console.log(`Wrote data/users.json with ${n} users`);
