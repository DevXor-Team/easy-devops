import express from 'express';
import { listAllCerts } from '../lib/cert-reader.js';
import { issueCert, renewCert } from '../../cli/managers/ssl-manager.js';
import { loadConfig } from '../../core/config.js';
import { promises as dns } from 'dns';

const router = express.Router();

// ─── In-memory DNS challenge state ────────────────────────────────────────────
// Keyed by domain name. Entries are cleaned up when the ACME process exits
// or when cancelled. Entries older than 10 minutes are forcibly removed.

const pendingDnsChallenges = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [domain, state] of pendingDnsChallenges) {
    if (now - state.createdAt > 10 * 60 * 1000) {
      state.confirmDeferred.reject(new Error('DNS challenge timed out after 10 minutes'));
      pendingDnsChallenges.delete(domain);
    }
  }
}, 60000);

// ─── POST /api/ssl/create ─────────────────────────────────────────────────────

router.post('/create', async (req, res) => {
  const { domain, www = false, validationMethod = 'http', email = null } = req.body ?? {};

  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return res.status(400).json({ error: 'domain is required' });
  }

  const domainKey = domain.trim();
  const config = loadConfig();
  const acmeEmail = email || config.acmeEmail;

  if (validationMethod === 'dns') {
    // Two-phase flow: spawn ACME process, wait for TXT record, respond 202, pause until confirm.
    let confirmResolve, confirmReject;
    const confirmPromise = new Promise((resolve, reject) => {
      confirmResolve = resolve;
      confirmReject = reject;
    });

    let resultResolve;
    const resultPromise = new Promise((resolve) => { resultResolve = resolve; });

    // Track whether a response has already been sent (202 from onDnsChallenge)
    let responseSent = false;

    const onDnsChallenge = async (txtName, txtValue) => {
      responseSent = true;
      pendingDnsChallenges.set(domainKey, {
        domain: domainKey,
        txtName,
        txtValue,
        confirmDeferred: { resolve: confirmResolve, reject: confirmReject },
        resultPromise,
        createdAt: Date.now(),
      });

      res.status(202).json({
        status: 'waiting_dns',
        domain: domainKey,
        txtName,
        txtValue,
        hint: 'Add a DNS TXT record with the name and value above, then call POST /api/ssl/create-confirm',
      });

      // Pause until user calls /create-confirm (resolves) or /create-cancel (rejects)
      await confirmPromise;
    };

    // Run issueCert in the background — it will call onDnsChallenge which sends 202 and pauses.
    issueCert(domainKey, { www: !!www, validationMethod: 'dns', email: acmeEmail, onDnsChallenge })
      .then(result => {
        resultResolve(result);
        pendingDnsChallenges.delete(domainKey);
        if (!responseSent) {
          responseSent = true;
          if (result.success) {
            return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
          }
          const { step } = result.error ?? {};
          if (step === 'email configuration') {
            return res.status(400).json({ error: 'email_required', hint: 'Configure acmeEmail in settings or provide email parameter.' });
          }
          return res.status(500).json({ success: false, error: result.error });
        }
      })
      .catch(err => {
        const errResult = {
          success: false,
          certPath: null,
          keyPath: null,
          error: {
            step: 'certificate issuance',
            cause: err.message,
            consequence: 'Unexpected error during DNS certificate issuance.',
            nginxRunning: true,
            configSaved: false,
          },
        };
        resultResolve(errResult);
        pendingDnsChallenges.delete(domainKey);
        if (!responseSent) {
          responseSent = true;
          return res.status(500).json({ success: false, error: errResult.error });
        }
      });

    // The response is sent either by onDnsChallenge (202) or by the .then()/.catch() above.
    return;
  }

  // HTTP validation path (synchronous — responds when complete)
  const result = await issueCert(domainKey, { www: !!www, validationMethod: 'http', email: acmeEmail });

  if (result.success) {
    return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
  }

  const { step } = result.error;
  if (step === 'email configuration') {
    return res.status(400).json({
      error: 'email_required',
      hint: 'Configure acmeEmail in settings or provide email parameter.',
    });
  }
  if (step === 'port 80 check') {
    return res.status(409).json({
      error: 'port_busy',
      detail: result.error.cause,
      hint: 'Stop the process using port 80 and try again.',
    });
  }
  return res.status(500).json({ success: false, error: result.error });
});

// ─── POST /api/ssl/create-confirm ────────────────────────────────────────────

router.post('/create-confirm', async (req, res) => {
  const { domain } = req.body ?? {};
  const domainKey = domain?.trim();
  const state = domainKey ? pendingDnsChallenges.get(domainKey) : null;

  if (!state) {
    return res.status(404).json({
      error: 'no_pending_challenge',
      hint: 'No DNS challenge is pending for this domain. Start a new certificate issuance.',
    });
  }

  try {
    const records = await dns.resolveTxt(`_acme-challenge.${domainKey}`);
    const flatRecords = records.flat();

    const found = flatRecords.includes(state.txtValue);
    if (!found) {
      return res.status(400).json({
        error: 'dns_not_propagated',
        hint: 'The expected TXT record value was not found. Make sure you added the correct TXT record and wait a few minutes for DNS propagation.',
        expected: state.txtValue,
        found: flatRecords,
      });
    }
  } catch (err) {
    return res.status(400).json({
      error: 'dns_lookup_failed',
      hint: 'Failed to lookup the expected TXT record. Make sure you added the correct TXT record.',
      detail: err.message,
    });
  }
  // Signal issueCert() to continue with the ACME process
  await state.confirmDeferred.resolve();

  // Wait for the ACME process to complete
  const result = await state.resultPromise;
  pendingDnsChallenges.delete(domainKey);

  if (result.success) {
    return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
  }
  return res.status(500).json({ success: false, error: result.error });
});

// ─── POST /api/ssl/create-cancel ─────────────────────────────────────────────

router.post('/create-cancel', async (req, res) => {
  const { domain } = req.body ?? {};
  const domainKey = domain?.trim();
  const state = domainKey ? pendingDnsChallenges.get(domainKey) : null;

  if (!state) {
    return res.status(404).json({
      error: 'no_pending_challenge',
      hint: 'No DNS challenge is pending for this domain.',
    });
  }

  // Reject the deferred — issueCert() will return a failure result
  state.confirmDeferred.reject(new Error('cancelled by user'));
  pendingDnsChallenges.delete(domainKey);

  return res.json({ cancelled: true });
});

// ─── GET /api/ssl ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const certs = await listAllCerts();
  res.json(certs);
});

// ─── POST /api/ssl/renew/:domain ─────────────────────────────────────────────

router.post('/renew/:domain', async (req, res) => {
  const domain = req.params.domain;
  const config = loadConfig();

  if (!config.acmeEmail) {
    return res.status(400).json({
      error: 'email_required',
      hint: 'Configure acmeEmail in settings first.',
    });
  }

  const certs = await listAllCerts();
  const found = certs.find(cert => cert.domain === domain);
  if (!found) {
    return res.status(404).json({ error: `Domain '${domain}' not found` });
  }

  const result = await renewCert(domain, { validationMethod: 'http', email: config.acmeEmail });

  if (result.success) {
    return res.json({ success: true, certPath: result.certPath, keyPath: result.keyPath });
  }

  const { step } = result.error;
  if (step === 'port 80 check') {
    return res.status(409).json({
      error: 'port_busy',
      detail: result.error.cause,
      hint: 'Stop the process using port 80 and try again.',
    });
  }
  return res.status(500).json({ success: false, error: result.error });
});

// ─── POST /api/ssl/renew-all ─────────────────────────────────────────────────

router.post('/renew-all', async (req, res) => {
  const config = loadConfig();

  if (!config.acmeEmail) {
    return res.status(400).json({
      error: 'email_required',
      hint: 'Configure acmeEmail in settings first.',
    });
  }

  const certs = await listAllCerts();
  const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
  const results = [];

  for (const cert of expiring) {
    const result = await renewCert(cert.domain, { validationMethod: 'http', email: config.acmeEmail });
    results.push({
      domain: cert.domain,
      success: result.success,
      certPath: result.certPath,
      keyPath: result.keyPath,
    });
  }

  res.json(results);
});

export default router;
