const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3001/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify'
  ],
  prompt: 'consent'
});

console.log('\n=== aeda Gmail Token Generator ===\n');
console.log('Open this URL in your browser and sign in as artur@aedawallet.com:\n');
console.log(authUrl);
console.log('\nWaiting for authorization on http://localhost:3001 ...\n');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/oauth2callback') return;

  const code = parsed.query.code;
  const error = parsed.query.error;

  if (error) {
    res.end('<h1>Failed: ' + error + '</h1><p>Close this tab.</p>');
    server.close();
    console.error('Authorization failed:', error);
    process.exit(1);
  }

  if (code) {
    res.end('<h1>Done! Return to terminal.</h1><p>You can close this tab.</p>');
    try {
      const { tokens } = await oauth2Client.getToken(code);
      console.log('\n=== REFRESH TOKEN ===\n');
      console.log(tokens.refresh_token);
      console.log('\nAdd this to Railway as GMAIL_REFRESH_TOKEN\n');
    } catch (err) {
      console.error('Token exchange failed:', err.message);
    }
    server.close();
    process.exit(0);
  }
});

server.listen(3001, () => {
  console.log('Listening on http://localhost:3001 ...');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port 3001 already in use. Free it and retry.');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
