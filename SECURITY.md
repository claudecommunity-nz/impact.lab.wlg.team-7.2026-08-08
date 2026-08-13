# Security

## Reporting

Open a GitHub issue titled "security" without exploit details, or email the
repository owner; include a way to reach you privately. Prototype scope:
no bounty, but reports are read and acted on.

## Design boundaries

- **No backend of ours.** The site is static assets plus a Cloudflare Worker
  that renders and serves them; there is no server-side state, database of
  ours, or authentication surface.
- **Bring-your-own-key stays in the browser.** Provider API keys live in the
  visitor's `localStorage` and are sent only to the provider host the visitor
  chose (`AGENT_PROVIDERS` in `site/app/data-sources.ts`) — never to any
  server of this project. The settings export strips keys and tokens.
- **Secret hygiene is test-enforced.** `site/tests/rendered-html.test.mjs`
  scans `site/app`, `worker`, `tests`, `public`, `scripts` and `src` for
  key-shaped strings on every build and fails naming the file. The root
  `.gitignore` refuses `.env`/key/pem files, `secrets/` and the settings
  export name.
- **Response headers.** Every worker response carries
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` and a
  restrictive `Permissions-Policy` (geolocation self-only). CORS
  (`Access-Control-Allow-Origin: *`) is deliberately enabled on the
  read-only `/cop/*` feeds and nowhere else.
- **No dynamic code paths.** No `eval`, no `dangerouslySetInnerHTML`, two
  runtime dependencies (react, react-dom).

## Known residual risks

- Any future XSS could exfiltrate a visitor's provider key from
  `localStorage`; the mitigation is keeping the rendering surface free of
  injected HTML, which the codebase currently is. Treat any new
  HTML-injection sink as a security regression.
- Camera frames are hotlinked from `trafficnz.info` in the visitor's
  browser; nothing is proxied or stored, but availability and content are
  NZTA's.
- The public COP feeds are exactly that — public. Nothing sensitive may be
  added to `site/public/`.
