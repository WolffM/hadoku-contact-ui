#!/usr/bin/env node
/**
 * One-time Google OAuth setup for Meet link generation.
 *
 * Prereqs:
 *   1. Create OAuth client at https://console.cloud.google.com/apis/credentials
 *      - Type: "Web application"
 *      - Authorized redirect URI: http://localhost:8080/oauth/callback
 *      - Save the Client ID and Client Secret
 *   2. Enable Google Calendar API for the project (APIs & Services → Library)
 *
 * Usage:
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/google-oauth-setup.mjs
 *
 * GRANT AS meeting@hadoku.me, not a personal account. Every booking writes a
 * calendar event — carrying a stranger's email as an attendee — onto whichever
 * account authorizes here. That is not incidental: the event is what makes
 * Google mint the Meet link, so there is no version of this that does not write.
 *
 * The script opens a browser, you grant calendar.events scope, and it prints a
 * refresh token to stdout. It goes in the VAULT, not `wrangler secret put` —
 * the broker is the only writer of worker secrets in this ecosystem. Full
 * procedure, including the manifest entry that must come after:
 *   ../hadoku_site/docs/operations/google-meet-setup.md
 */

import http from 'node:http'
import { URL } from 'node:url'
import { spawn } from 'node:child_process'

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET
const REDIRECT_URI = 'http://localhost:8080/oauth/callback'
const SCOPES = ['https://www.googleapis.com/auth/calendar.events']

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars first.')
  process.exit(1)
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

console.log('\nOpen this URL in your browser to authorize:\n')
console.log(authUrl.toString())
console.log('\n(Listening on http://localhost:8080 for the redirect...)\n')

// Try to open browser automatically
const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
spawn(opener, [authUrl.toString()], { stdio: 'ignore', detached: true }).unref()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080')
  if (url.pathname !== '/oauth/callback') {
    res.statusCode = 404
    return res.end('Not found')
  }
  const code = url.searchParams.get('code')
  if (!code) {
    res.statusCode = 400
    return res.end('Missing code')
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    })
    const data = await tokenRes.json()

    if (!tokenRes.ok || !data.refresh_token) {
      res.statusCode = 500
      res.end(`Token exchange failed: ${JSON.stringify(data)}`)
      console.error('\nFailed:', data)
      server.close()
      process.exit(1)
    }

    res.end('Success! You can close this tab. Refresh token printed in your terminal.')

    console.log('\n=== REFRESH TOKEN ===')
    console.log(data.refresh_token)
    console.log('\nStore in the VAULT as MEETING_GOOGLE_REFRESH_TOKEN (not `wrangler')
    console.log('secret put` — the broker is the only writer of worker secrets):')
    console.log(`  curl -X POST "$MGMT_API_BASE/api/secrets/admin/set-many" \\`)
    console.log(`       -H 'Content-Type: application/json' \\`)
    console.log(`       -H "X-Admin-Key: $HADOKU_ADMIN_KEY" \\`)
    console.log(`       -d '{"items": {"MEETING_GOOGLE_REFRESH_TOKEN": "<token above>"}}'`)
    console.log('\nThen see ../hadoku_site/docs/operations/google-meet-setup.md')
    console.log('for the manifest entry and the push — in that order.\n')

    server.close()
    process.exit(0)
  } catch (e) {
    res.statusCode = 500
    res.end(`Error: ${e.message}`)
    console.error(e)
    server.close()
    process.exit(1)
  }
})

server.listen(8080)
