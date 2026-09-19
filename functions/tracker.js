export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    const userAgent = request.headers.get('user-agent') || '';
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const userData = body.user_data || {};

    const fbp = validateFbCookie(userData.fbp) || validateFbCookie(cookies['_fbp']) || '';
    const fbc = validateFbCookie(userData.fbc) || validateFbCookie(cookies['_fbc']) || '';
    const externalId = userData.external_id || '';

    async function sha256(value) {
      if (!value) return '';
      const normalized = value.toLowerCase().trim();
      const encoded = new TextEncoder().encode(normalized);
      const buffer = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    function normalizePhone(ph, countryCode) {
      if (!ph) return '';
      const cc = String(countryCode || '1');
      const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
      if (!digits) return '';
      if (digits.length >= 8 && digits.length <= 11) {
        return cc + digits;
      }
      return digits;
    }

    function normalizeName(name) {
      if (!name) return '';
      return name.trim().toLowerCase();
    }

    const hashedEm = await sha256(userData.em);
    const hashedFn = await sha256(normalizeName(userData.fn));
    const hashedLn = await sha256(normalizeName(userData.ln));
    const hashedPh = await sha256(normalizePhone(userData.ph, env.DEFAULT_COUNTRY_CODE));
    const hashedExternalId = await sha256(externalId);

    const results = await Promise.allSettled([
      sendToMeta({ body, clientIp, userAgent, fbp, fbc, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, env }),
      sendToGA4({ body, hashedEm, env }),
    ]);

    let metaStatusCode = 0, metaResponseOk = 0, metaResponseBody = '';
    if (results[0]?.status === 'fulfilled' && results[0].value) {
      const v = results[0].value;
      if (v.skipped) {
        metaResponseBody = `skipped: ${v.skipped}`;
      } else if (v.response) {
        metaStatusCode = v.response.status;
        metaResponseOk = v.response.ok ? 1 : 0;
        try { metaResponseBody = await v.response.text(); } catch (e) { metaResponseBody = `Read error: ${e.message}`; }
      }
    } else if (results[0]?.status === 'rejected') {
      metaResponseBody = `Fetch error: ${results[0].reason?.message || 'unknown'}`;
    }

    const rawEmail = userData.em || '';

    context.waitUntil(
      (async () => {
        try {
          if (env.DB && body.event_name && body.event_name.toLowerCase() !== 'pageview' && body.event_name.toLowerCase() !== 'page_view') {
            await env.DB.prepare(`
              INSERT INTO event_log (
                session_id, event_name, event_id, timestamp,
                is_bot, bot_reason,
                sent_to_meta, meta_status_code, meta_response_ok, meta_response_body,
                has_email, has_phone, has_name,
                raw_email
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              cookies['_krob_sid'] || '', body.event_name, body.event_id, body.event_time,
              0, '',
              1, metaStatusCode, metaResponseOk, metaResponseBody,
              hashedEm ? 1 : 0, hashedPh ? 1 : 0, (hashedFn || hashedLn) ? 1 : 0,
              rawEmail
            ).run();
          }
        } catch (e) {
          console.error('D1 log error:', e.message);
        }
      })()
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
}

async function sendToMeta({ body, clientIp, userAgent, fbp, fbc, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'missing meta env', payload: null, response: null };
  }

  const metaUserData = {
    client_ip_address: clientIp,
    client_user_agent: userAgent,
  };

  if (hashedEm) metaUserData.em = [hashedEm];
  if (hashedFn) metaUserData.fn = [hashedFn];
  if (hashedLn) metaUserData.ln = [hashedLn];
  if (hashedPh) metaUserData.ph = [hashedPh];
  if (hashedExternalId) metaUserData.external_id = [hashedExternalId];
  if (fbp) metaUserData.fbp = fbp;
  if (fbc) metaUserData.fbc = fbc;

  const payload = {
    data: [{
      event_name: body.event_name,
      event_time: body.event_time,
      event_id: body.event_id,
      event_source_url: 'https://conxinch.com',
      action_source: 'website',
      user_data: metaUserData,
    }],
  };

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(`https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payloadJson,
  });
  return { payload: payloadJson, response };
}

async function sendToGA4({ body, hashedEm, env }) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return { skipped: 'missing ga4 env', payload: null, response: null };
  }

  const eventName = (body.event_name || '').toLowerCase();
  if (eventName === 'pageview' || eventName === 'page_view') {
    return { skipped: 'pageview', payload: null, response: null };
  }

  const ga4EventName = eventName === 'lead' ? 'generate_lead'
    : eventName === 'purchase' ? 'purchase'
    : eventName === 'initiatecheckout' ? 'begin_checkout'
    : eventName;

  const payload = {
    client_id: `${Date.now()}.${Math.floor(Math.random() * 1000000000)}`,
    events: [{
      name: ga4EventName,
      params: {
        page_location: body.event_source_url || '',
      },
    }],
  };

  if (hashedEm) {
    payload.user_properties = { email: { value: hashedEm } };
  }

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payloadJson,
  });
  return { payload: payloadJson, response };
}

function validateFbCookie(value) {
  if (!value) return '';
  const parts = value.split('.');
  if (parts.length < 4 || parts.length > 5) return '';
  if (parts[0] !== 'fb') return '';
  if (!/^\d+$/.test(parts[1])) return '';
  if (!/^\d+$/.test(parts[2])) return '';
  if (!parts[3]) return '';
  return value;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}
