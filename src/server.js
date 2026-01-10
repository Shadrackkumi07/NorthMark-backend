import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const app = express();
const port = process.env.PORT || 5000;
const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const adminToken = process.env.ADMIN_TOKEN || '';

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    }
  })
);
app.use(express.json({ limit: '200kb' }));

const required = [
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'ZOHO_ACCOUNT_ID',
  'ZOHO_FROM_ADDRESS',
  'ZOHO_TO_ADDRESS'
];

const hasAllSecrets = required.every((key) => Boolean(process.env[key]));
const reviewsFile = path.join(process.cwd(), 'data', 'reviews.json');

const sanitize = (value) =>
  String(value || '')
    .replace(/[<>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

const formatPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return value || '';
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
};

async function ensureReviewsFile() {
  try {
    await fs.access(reviewsFile);
  } catch (error) {
    const seed = { reviews: [] };
    await fs.mkdir(path.dirname(reviewsFile), { recursive: true });
    await fs.writeFile(reviewsFile, JSON.stringify(seed, null, 2));
  }
}

async function readReviews() {
  await ensureReviewsFile();
  const content = await fs.readFile(reviewsFile, 'utf8');
  const parsed = JSON.parse(content || '{}');
  const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  return reviews;
}

async function writeReviews(reviews) {
  await fs.writeFile(reviewsFile, JSON.stringify({ reviews }, null, 2));
}

async function getAccessToken() {
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const response = await fetch(`https://accounts.zoho.com/oauth/v2/token?${params.toString()}`, {
    method: 'POST'
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Zoho token error: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function sendZohoMail({ name, email, phone, zip, services }) {
  const accessToken = await getAccessToken();
  const accountId = process.env.ZOHO_ACCOUNT_ID;
  const fromAddress = process.env.ZOHO_FROM_ADDRESS;
  const toAddress = process.env.ZOHO_TO_ADDRESS;
  const safeServices = Array.isArray(services) ? services.map(sanitize).filter(Boolean) : [];
  const servicesBlock = safeServices.length
    ? `<ul>${safeServices.map((service) => `<li>${service}</li>`).join('')}</ul>`
    : '<p>No services selected.</p>';
  const submittedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

  const payload = {
    fromAddress,
    toAddress,
    subject: 'New Estimate Request - Northmark Facility Services',
    content: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2 style="margin: 0 0 12px;">Estimate Request</h2>
        <table style="border-collapse: collapse; width: 100%; max-width: 520px;">
          <tr>
            <td style="padding: 6px 0; font-weight: 600;">Name</td>
            <td style="padding: 6px 0;">${name}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: 600;">Email</td>
            <td style="padding: 6px 0;">${email}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: 600;">Phone</td>
            <td style="padding: 6px 0;">${phone}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: 600;">Zip Code</td>
            <td style="padding: 6px 0;">${zip}</td>
          </tr>
        </table>
        <div style="margin-top: 12px;">
          <div style="font-weight: 600; margin-bottom: 6px;">Services Requested</div>
          ${servicesBlock}
        </div>
        <div style="margin-top: 12px; font-size: 12px; color: #475569;">
          Submitted ${submittedAt}
        </div>
      </div>
    `
  };

  const response = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Zoho mail error response:', text);
    throw new Error(`Zoho mail error: ${text}`);
  }

  return response.json();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, mailConfigured: hasAllSecrets });
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/reviews', async (req, res) => {
  try {
    const reviews = await readReviews();
    res.json({ reviews });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load reviews.' });
  }
});

app.post('/reviews', async (req, res) => {
  const { name, company, rating, text, service } = req.body || {};
  if (!name || !company || !rating || !text || !service) {
    res.status(400).json({ error: 'Missing required fields.' });
    return;
  }

  const parsedRating = Math.min(Math.max(Number(rating), 1), 5);
  const entry = {
    id: Date.now(),
    name: sanitize(name),
    company: sanitize(company),
    rating: parsedRating,
    text: sanitize(text),
    service: sanitize(service),
    date: new Date().toISOString().slice(0, 10),
    source: 'user'
  };

  try {
    const reviews = await readReviews();
    reviews.unshift(entry);
    await writeReviews(reviews);
    res.json({ ok: true, review: entry });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save review.' });
  }
});

app.delete('/reviews/:id', async (req, res) => {
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    res.status(403).json({ error: 'Unauthorized.' });
    return;
  }

  const id = Number(req.params.id);
  try {
    const reviews = await readReviews();
    const filtered = reviews.filter((review) => review.id !== id);
    await writeReviews(filtered);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete review.' });
  }
});

app.delete('/reviews', async (req, res) => {
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    res.status(403).json({ error: 'Unauthorized.' });
    return;
  }

  try {
    const reviews = await readReviews();
    const filtered = reviews.filter((review) => review.source !== 'user');
    await writeReviews(filtered);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear reviews.' });
  }
});

app.post('/estimate', async (req, res) => {
  const { firstName, lastName, email, phone, zip, services } = req.body || {};
  const cleanServices = Array.isArray(services)
    ? services.map(sanitize).filter(Boolean)
    : [];

  if (!firstName || !lastName || !email || !phone || !zip || !cleanServices.length) {
    res.status(400).json({ error: 'Missing required fields.' });
    return;
  }

  if (!hasAllSecrets) {
    res.status(500).json({ error: 'Zoho mail is not configured on the server.' });
    return;
  }

  const name = `${sanitize(firstName)} ${sanitize(lastName)}`.trim();
  const cleanEmail = sanitize(email).toLowerCase();
  const cleanPhone = formatPhone(phone);
  const cleanZip = sanitize(zip);

  try {
    await sendZohoMail({
      name,
      email: cleanEmail,
      phone: cleanPhone,
      zip: cleanZip,
      services: cleanServices
    });
    res.json({ ok: true, message: 'Estimate request sent.' });
  } catch (error) {
    console.error('Estimate submission failed:', error.message);
    res.status(500).json({ error: 'Failed to send estimate request.' });
  }
});

app.listen(port, () => {
  console.log(`NorthMark backend running on port ${port}`);
});
