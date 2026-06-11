// /join deep-link redirect — extracted from server.js so it is unit-testable.
//
// Redirects /join?code=XYZ[&slot=N] to the hash-based deep link the client
// parses on load (`#join=XYZ[&slot=N]`, see _checkGameDeepLink in src/main.js).

export function handleJoinRedirect(req, res) {
  const code = (req.query.code || '').trim();
  if (!code) { res.status(400).send('Missing game code.'); return; }
  const slot = req.query.slot;
  let hash = `#join=${encodeURIComponent(code)}`;
  if (slot != null && slot !== '') hash += `&slot=${encodeURIComponent(slot)}`;
  res.redirect(`/${hash}`);
}
