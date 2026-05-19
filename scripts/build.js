const fs = require('fs');
const path = require('path');

console.log("Starting frontend build step...");

const appJsPath = path.join(__dirname, '..', 'frontend', 'app.js');
let appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Use BACKEND_URL from environment variables (e.g., from Vercel settings or .env)
const backendUrl = process.env.BACKEND_URL || "http://localhost:3005";
console.log(`Injecting BACKEND_URL: ${backendUrl}`);

// Replace the hardcoded backendUrl in the CONFIG object
appJsContent = appJsContent.replace(
  /backendUrl:\s*["'][^"']*["']/g,
  `backendUrl: "${backendUrl}"`
);

fs.writeFileSync(appJsPath, appJsContent);
console.log("Build complete! Frontend app.js updated.");
