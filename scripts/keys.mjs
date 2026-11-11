// Prints two new random keys for the Worker secrets.
import {randomBytes} from "node:crypto";
const key = () => randomBytes(32).toString("base64url");
console.log(`UPLOAD_TOKEN  (extension only, keep private):\n  ${key()}\n`);
console.log(`FEED_TOKEN    (goes into the class calendar links):\n  ${key()}\n`);
console.log("Set them with:  npx wrangler secret put UPLOAD_TOKEN   and   npx wrangler secret put FEED_TOKEN");
