require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ddithxstvpgwkqckljze.supabase.co';

app.use(express.json());

/* normaliza barras duplas/triplas → redirect 301 para URL limpa */
app.use((req, res, next) => {
  if (/\/{2,}/.test(req.path)) {
    const clean = req.path.replace(/\/{2,}/g, '/');
    return res.redirect(301, clean + req.url.slice(req.path.length));
  }
  next();
});

/* ============================================================
   ROOT ROUTE — serve HTML correto conforme tipo do salão
   (deve ficar ANTES do express.static)
============================================================ */
/* mapa tipo → arquivo HTML (adicione novos tipos aqui) */
const TIPO_HTML = {
  barbearia: 'barbearia.html',
  salao:     'studiobeauty.html',
};

app.get('/', async (req, res) => {
  try {
    const slug = resolveSlug(req);
    if (slug) {
      const { data } = await supaFetch('GET', `saloes?slug=eq.${encodeURIComponent(slug)}&select=tipo`);
      const tipo = data?.[0]?.tipo;
      const file = TIPO_HTML[tipo];
      if (file) return res.sendFile(path.join(__dirname, file));
    }
  } catch (e) {
    console.error('Root route error:', e.message);
  }
  res.sendFile(path.join(__dirname, 'studiobeauty.html'));
});

app.use(express.static(__dirname));

/* ============================================================
   SUPABASE SERVICE ROLE HELPER
============================================================ */
async function supaFetch(method, path, body) {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_KEY não configurada.');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey':        serviceKey,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const isJson = r.headers.get('content-type')?.includes('json');
  const data   = isJson ? await r.json() : null;
  return { ok: r.ok, status: r.status, data };
}

/* ============================================================
   RESOLVE SLUG DO SALÃO A PARTIR DA REQUISIÇÃO
   Ordem: query ?salao=slug → body.slug → subdomínio
============================================================ */
function resolveSlug(req) {
  if (req.query.salao) return req.query.salao;
  if (req.body?.slug)  return req.body.slug;
  const host = req.headers.host || '';
  const sub  = host.split('.')[0];
  if (sub && sub !== 'www' && !/localhost|127\.0\.0\.1/.test(host)) return sub;
  return null;
}

/* ============================================================
   CONFIG — retorna dados do salão, serviços e combos
============================================================ */
app.get('/config', async (req, res) => {
  try {
    let slug = resolveSlug(req);

    if (!slug) {
      // Dev: usa o primeiro salão cadastrado
      const { data } = await supaFetch('GET', 'saloes?limit=1&select=slug');
      if (!data?.length) return res.status(404).json({ error: 'Nenhum salão cadastrado.' });
      slug = data[0].slug;
    }

    const { data: saloes } = await supaFetch('GET',
      `saloes?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nome,cor_primaria,whatsapp,instagram,endereco,bairro,cidade,horarios,email_from,hero_titulo,hero_desc`
    );
    if (!saloes?.length) return res.status(404).json({ error: 'Salão não encontrado.' });
    const salao = saloes[0];

    const [{ data: servicos }, { data: combos }] = await Promise.all([
      supaFetch('GET', `servicos?salao_id=eq.${salao.id}&ativo=eq.true&order=id.asc&select=id,nome,preco,duracao,icone,categoria`),
      supaFetch('GET', `combos?salao_id=eq.${salao.id}&ativo=eq.true&order=id.asc&select=id,nome,preco,duracao`),
    ]);

    res.json({ salao, servicos: servicos || [], combos: combos || [] });
  } catch (e) {
    console.error('/config error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   ADMIN SESSIONS (em memória — limpa ao reiniciar)
============================================================ */
const adminSessions = new Map(); // token -> { expiry, salao_id }

function adminMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Não autorizado.' });
  const session = adminSessions.get(token);
  if (!session || Date.now() > session.expiry) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
  req.salao_id = session.salao_id;
  next();
}

/* ============================================================
   ADMIN AUTH — valida credenciais contra o banco por slug
============================================================ */
app.post('/admin/auth', async (req, res) => {
  try {
    const { username, password } = req.body;
    const slug = resolveSlug(req);

    if (!slug) return res.status(400).json({ error: 'Salão não identificado.' });

    const { data: saloes } = await supaFetch('GET',
      `saloes?slug=eq.${encodeURIComponent(slug)}&select=id,admin_user,admin_pass`
    );
    const salao = saloes?.[0];
    if (!salao || username !== salao.admin_user || password !== salao.admin_pass) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, { expiry: Date.now() + 8 * 60 * 60 * 1000, salao_id: salao.id });
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   ADMIN BOOKING ROUTES — filtrados por salao_id da sessão
============================================================ */
app.patch('/admin/booking/:id', adminMiddleware, async (req, res) => {
  try {
    const filter = req.salao_id
      ? `agendamentos?id=eq.${req.params.id}&salao_id=eq.${req.salao_id}`
      : `agendamentos?id=eq.${req.params.id}`;
    const { ok } = await supaFetch('PATCH', filter, req.body);
    res.status(ok ? 200 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/booking/:id', adminMiddleware, async (req, res) => {
  try {
    const filter = req.salao_id
      ? `agendamentos?id=eq.${req.params.id}&salao_id=eq.${req.salao_id}`
      : `agendamentos?id=eq.${req.params.id}`;
    const { ok } = await supaFetch('DELETE', filter);
    res.status(ok ? 200 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/bookings', adminMiddleware, async (req, res) => {
  try {
    const filter = req.salao_id
      ? `agendamentos?salao_id=eq.${req.salao_id}&order=date.asc,time.asc&select=*`
      : `agendamentos?order=date.asc,time.asc&select=*`;
    const { ok, data } = await supaFetch('GET', filter);
    res.status(ok ? 200 : 500).json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/booking', adminMiddleware, async (req, res) => {
  try {
    const body = req.salao_id ? { ...req.body, salao_id: req.salao_id } : req.body;
    const { ok } = await supaFetch('POST', 'agendamentos', body);
    res.status(ok ? 201 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/admin/settings', adminMiddleware, async (req, res) => {
  try {
    if (!req.salao_id) return res.status(400).json({ error: 'Sessão sem salão vinculado.' });
    const allowed = ['admin_user', 'admin_pass', 'cidade', 'horarios'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para atualizar.' });
    const { ok } = await supaFetch('PATCH', `saloes?id=eq.${req.salao_id}`, updates);
    res.status(ok ? 200 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   SERVIÇOS — admin pode atualizar nome/preço/duração
============================================================ */
app.patch('/admin/servico/:id', adminMiddleware, async (req, res) => {
  try {
    const allowed = ['nome', 'preco', 'duracao'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para atualizar.' });
    const filter = req.salao_id
      ? `servicos?id=eq.${req.params.id}&salao_id=eq.${req.salao_id}`
      : `servicos?id=eq.${req.params.id}`;
    const { ok } = await supaFetch('PATCH', filter, updates);
    res.status(ok ? 200 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/admin/combo/:id', adminMiddleware, async (req, res) => {
  try {
    const allowed = ['nome', 'preco', 'duracao'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para atualizar.' });
    const filter = req.salao_id
      ? `combos?id=eq.${req.params.id}&salao_id=eq.${req.salao_id}`
      : `combos?id=eq.${req.params.id}`;
    const { ok } = await supaFetch('PATCH', filter, updates);
    res.status(ok ? 200 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   BLOQUEIOS — congelar horários ou dias inteiros
============================================================ */

// Rota pública: retorna bloqueios de uma data (usado pelo site)
app.get('/bloqueios', async (req, res) => {
  try {
    const { salao_id, date } = req.query;
    if (!salao_id || !date) return res.json([]);
    const { ok, data } = await supaFetch('GET',
      `bloqueios?salao_id=eq.${salao_id}&data=eq.${date}&select=id,dia_inteiro,hora_inicio,hora_fim,motivo`
    );
    res.status(ok ? 200 : 500).json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: listar bloqueios do salão
app.get('/admin/bloqueios', adminMiddleware, async (req, res) => {
  try {
    const filter = req.salao_id
      ? `bloqueios?salao_id=eq.${req.salao_id}&order=data.asc,hora_inicio.asc&select=*`
      : `bloqueios?order=data.asc,hora_inicio.asc&select=*`;
    const { ok, data } = await supaFetch('GET', filter);
    res.status(ok ? 200 : 500).json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: criar bloqueio
app.post('/admin/bloqueio', adminMiddleware, async (req, res) => {
  try {
    if (!req.salao_id) return res.status(400).json({ error: 'Sessão sem salão vinculado.' });
    const { data: dt, hora_inicio, hora_fim, dia_inteiro, motivo } = req.body;
    if (!dt) return res.status(400).json({ error: 'Data obrigatória.' });
    const body = { salao_id: req.salao_id, data: dt, dia_inteiro: !!dia_inteiro, motivo: motivo || null };
    if (!dia_inteiro) {
      if (!hora_inicio || !hora_fim) return res.status(400).json({ error: 'Informe hora_inicio e hora_fim.' });
      body.hora_inicio = hora_inicio;
      body.hora_fim    = hora_fim;
    }
    const { ok } = await supaFetch('POST', 'bloqueios', body);
    res.status(ok ? 201 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: remover bloqueio
app.delete('/admin/bloqueio/:id', adminMiddleware, async (req, res) => {
  try {
    const filter = req.salao_id
      ? `bloqueios?id=eq.${req.params.id}&salao_id=eq.${req.salao_id}`
      : `bloqueios?id=eq.${req.params.id}`;
    const { ok } = await supaFetch('DELETE', filter);
    res.status(ok ? 200 : 500).json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   EMAIL DE CONFIRMAÇÃO via Resend
============================================================ */
app.post('/send-booking-email', async (req, res) => {
  const { name, email, service, date, time, duration, price, salao_id } = req.body;
  if (!email || !name) return res.status(400).json({ error: 'Dados insuficientes.' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Serviço de email não configurado.' });

  let salonNome = 'Studio Beauty', salonWa = '5531987899520', salonCidade = 'Horizonte — MG', emailFrom = 'contato@fluzzia.net', salonTipo = 'salao';
  if (salao_id) {
    const { data } = await supaFetch('GET', `saloes?id=eq.${salao_id}&select=nome,whatsapp,cidade,email_from,tipo`)
      .catch(() => ({ data: null }));
    if (data?.[0]) {
      salonNome   = data[0].nome       || salonNome;
      salonWa     = data[0].whatsapp   || salonWa;
      salonCidade = data[0].cidade     || salonCidade;
      emailFrom   = data[0].email_from || emailFrom;
      salonTipo   = data[0].tipo       || salonTipo;
    }
  }

  const h = Math.floor(duration / 60), m = duration % 60;
  const durStr = h && m ? `${h}h${String(m).padStart(2,'0')}min` : h ? `${h}h` : `${m}min`;
  const [y, mo, d] = (date || '').split('-');
  const dateBR = date ? `${d}/${mo}/${y}` : '—';

  const isBarbearia = salonTipo === 'barbearia';

  const html = isBarbearia ? `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#111;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#1a1a1a;border-radius:4px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.6);border:1px solid #2a2a2a;">
        <tr>
          <td style="background:linear-gradient(135deg,#1a1a1a,#0a0a0a);padding:36px 32px 28px;text-align:center;border-bottom:2px solid #C4A25A;">
            <p style="margin:0 0 12px;font-size:11px;color:#C4A25A;letter-spacing:4px;text-transform:uppercase;font-weight:600;">✂ Agendamento Confirmado</p>
            <h1 style="margin:0;font-size:26px;color:#fff;font-weight:700;letter-spacing:1px;">${salonNome.toUpperCase()}</h1>
            <p style="margin:10px 0 0;color:#888;font-size:13px;letter-spacing:1px;">Seu horário está reservado</p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 24px;font-size:14px;color:#aaa;letter-spacing:.3px;">Olá, <strong style="color:#fff;">${name}</strong>. Confirmamos seu agendamento abaixo.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden;border:1px solid #2a2a2a;margin-bottom:24px;">
              <tr><td style="padding:14px 18px;border-bottom:1px solid #2a2a2a;background:#111;">
                <span style="font-size:10px;color:#C4A25A;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Serviço</span><br/>
                <span style="font-size:15px;color:#fff;font-weight:600;">${service}</span>
              </td></tr>
              <tr><td style="padding:14px 18px;border-bottom:1px solid #2a2a2a;background:#111;">
                <span style="font-size:10px;color:#C4A25A;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Data</span><br/>
                <span style="font-size:15px;color:#fff;font-weight:600;">${dateBR}</span>
              </td></tr>
              <tr><td style="padding:14px 18px;border-bottom:1px solid #2a2a2a;background:#111;">
                <span style="font-size:10px;color:#C4A25A;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Horário</span><br/>
                <span style="font-size:15px;color:#fff;font-weight:600;">${time} (${durStr})</span>
              </td></tr>
              <tr><td style="padding:14px 18px;background:#111;">
                <span style="font-size:10px;color:#C4A25A;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Valor</span><br/>
                <span style="font-size:15px;color:#fff;font-weight:600;">${price || 'A confirmar'}</span>
              </td></tr>
            </table>
            <p style="margin:0 0 24px;font-size:13px;color:#666;line-height:1.7;">Para remarcar ou cancelar, acesse o site e vá em <strong style="color:#aaa;">Meus Agendamentos</strong>.</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center">
                <a href="https://wa.me/${salonWa}" style="display:inline-block;background:#25D366;color:#fff;font-size:13px;font-weight:700;text-decoration:none;padding:13px 32px;border-radius:2px;letter-spacing:1px;text-transform:uppercase;">
                  💬 Falar no WhatsApp
                </a>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#0a0a0a;padding:20px 32px;text-align:center;border-top:1px solid #2a2a2a;">
            <p style="margin:0;font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;">${salonNome} — ${salonCidade}</p>
            <p style="margin:6px 0 0;font-size:11px;color:#333;">Este email foi enviado automaticamente. Não responda.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>` : `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f0f1;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0f1;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#C4607A,#9E3F5A);padding:32px 32px 24px;text-align:center;">
            <h1 style="margin:0;font-size:22px;color:#fff;font-weight:700;">Agendamento Confirmado!</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:14px;">Estamos ansiosos para receber você 🌸</p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;">
            <p style="margin:0 0 20px;font-size:15px;color:#3a2428;">Olá, <strong>${name}</strong>! Seu agendamento foi confirmado com sucesso.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf5f6;border-radius:12px;overflow:hidden;border:1px solid #f0dde1;margin-bottom:24px;">
              <tr><td style="padding:14px 18px;border-bottom:1px solid #f0dde1;">
                <span style="font-size:12px;color:#9e7070;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Serviço</span><br/>
                <span style="font-size:15px;color:#2a1418;font-weight:600;">${service}</span>
              </td></tr>
              <tr><td style="padding:14px 18px;border-bottom:1px solid #f0dde1;">
                <span style="font-size:12px;color:#9e7070;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Data</span><br/>
                <span style="font-size:15px;color:#2a1418;font-weight:600;">${dateBR}</span>
              </td></tr>
              <tr><td style="padding:14px 18px;border-bottom:1px solid #f0dde1;">
                <span style="font-size:12px;color:#9e7070;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Horário</span><br/>
                <span style="font-size:15px;color:#2a1418;font-weight:600;">${time} (${durStr})</span>
              </td></tr>
              <tr><td style="padding:14px 18px;">
                <span style="font-size:12px;color:#9e7070;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Valor</span><br/>
                <span style="font-size:15px;color:#2a1418;font-weight:600;">${price || 'A confirmar'}</span>
              </td></tr>
            </table>
            <p style="margin:0 0 24px;font-size:14px;color:#7a5860;line-height:1.6;">Caso precise remarcar ou cancelar, acesse o site e vá em <strong>Meus Agendamentos</strong>.</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center">
                <a href="https://wa.me/${salonWa}" style="display:inline-block;background:#25D366;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:50px;">
                  💬 Falar no WhatsApp
                </a>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#fdf5f6;padding:20px 32px;text-align:center;border-top:1px solid #f0dde1;">
            <p style="margin:0;font-size:12px;color:#b08090;">${salonNome} — ${salonCidade}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#c9a0a8;">Este email foi enviado automaticamente. Não responda.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${salonNome} <${emailFrom}>`,
        to:      [email],
        subject: `✅ Agendamento Confirmado — ${salonNome}`,
        html
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data });
    res.json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: 'Falha ao enviar email.' });
  }
});

app.listen(PORT, () => console.log(`Fluzzia rodando na porta ${PORT}`));
