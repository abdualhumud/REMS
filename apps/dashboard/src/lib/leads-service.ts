/**
 * leads-service.ts — Multi-channel lead capture for REMS landing page
 *
 * Submission pipeline (all run in parallel, each fails gracefully):
 *   1. localStorage  — always persisted, primary store for Super-Admin view
 *   2. EmailJS REST  — real-time alert to alhumudab@gmail.com ✓ configured
 *                      Requires: NEXT_PUBLIC_EMAILJS_SERVICE_ID
 *                                NEXT_PUBLIC_EMAILJS_TEMPLATE_ID
 *                                NEXT_PUBLIC_EMAILJS_PUBLIC_KEY
 *   3. Google Sheets — append row via Apps Script webhook (optional)
 *                      Requires: NEXT_PUBLIC_SHEETS_WEBHOOK
 *   4. Supabase      — insert to `leads` table when credentials are configured
 *
 * None of the optional channels block submission — if env vars are missing the
 * step is skipped silently and the lead is still saved to localStorage.
 */

export type LeadSource = 'demo' | 'contact';
export type LeadStatus = 'new' | 'contacted' | 'converted' | 'closed';

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string;
  business: string;
  message: string;
  source: LeadSource;
  status: LeadStatus;
  createdAt: string;
}

export interface SubmitResult {
  ok: boolean;
  channels: { localStorage: boolean; email: boolean; sheets: boolean; supabase: boolean };
}

/* ── Storage ─────────────────────────────────────────────────────────────── */

const LEADS_KEY = 'rems-leads';

export function getLeads(): Lead[] {
  try {
    return JSON.parse(localStorage.getItem(LEADS_KEY) ?? '[]') as Lead[];
  } catch { return []; }
}

export function updateLeadStatus(id: string, status: LeadStatus): void {
  const leads = getLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return;
  leads[idx] = { ...leads[idx], status };
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
}

export function deleteLead(id: string): void {
  const leads = getLeads().filter(l => l.id !== id);
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
}

function saveLead(lead: Lead): void {
  const leads = getLeads();
  leads.unshift(lead);
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads.slice(0, 500)));
}

/* ── Remote leads (Supabase) — authenticated admin only (RLS) ───────────── */

import { supabase, isSupabaseConfigured } from '@/lib/supabase';

type LeadRow = {
  id: string; name: string; email: string; phone: string | null; business: string | null;
  message: string | null; source: LeadSource; status: LeadStatus; created_at: string;
};

export async function hasRemoteSession(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

export async function signInRemote(email: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? error.message : null;
}

export async function signOutRemote(): Promise<void> { await supabase.auth.signOut(); }

export async function fetchRemoteLeads(): Promise<Lead[]> {
  const { data, error } = await supabase
    .from('leads').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as LeadRow[]).map(r => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone ?? '', business: r.business ?? '',
    message: r.message ?? '', source: r.source, status: r.status, createdAt: r.created_at,
  }));
}

export async function updateRemoteLeadStatus(id: string, status: LeadStatus): Promise<void> {
  const { error } = await (supabase.from('leads') as ReturnType<typeof supabase.from>)
    .update({ status }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteRemoteLead(id: string): Promise<void> {
  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/* ── EmailJS REST API ────────────────────────────────────────────────────── */

async function sendEmailJS(lead: Lead): Promise<void> {
  const serviceId  = process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID;
  const templateId = process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID;
  const publicKey  = process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY;
  if (!serviceId || !templateId || !publicKey) return;

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  serviceId,
      template_id: templateId,
      user_id:     publicKey,
      template_params: {
        to_email:      'alhumudab@gmail.com',
        lead_source:   lead.source === 'demo' ? 'Demo Request' : 'Contact Inquiry',
        lead_name:     lead.name,
        lead_email:    lead.email,
        lead_phone:    lead.phone || '—',
        lead_business: lead.business || '—',
        lead_message:  lead.message || '—',
        lead_time:     new Date(lead.createdAt).toLocaleString('en-SA', { timeZone: 'Asia/Riyadh' }),
      },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}`);
}

/* ── Google Sheets via Apps Script Webhook ───────────────────────────────── */

/**
 * HMAC-SHA256 (hex) — Web Crypto API, browser-safe.
 * Used to sign the Sheets webhook body so the Apps Script can reject
 * forged submissions from anyone who happens to find the webhook URL.
 */
async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function logToSheets(lead: Lead): Promise<void> {
  const webhookUrl = process.env.NEXT_PUBLIC_SHEETS_WEBHOOK;
  if (!webhookUrl) return;

  const body = JSON.stringify({
    timestamp: new Date(lead.createdAt).toLocaleString('en-SA', { timeZone: 'Asia/Riyadh' }),
    name:      lead.name,
    email:     lead.email,
    phone:     lead.phone,
    business:  lead.business,
    message:   lead.message,
    source:    lead.source === 'demo' ? 'Demo Request' : 'Contact Inquiry',
    status:    'New',
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Sign the request when a shared secret is configured so the Apps Script
  // can verify authenticity. Apps Script side: compute HMAC-SHA256 of
  // e.postData.contents using the same secret and reject on mismatch.
  const secret = process.env.NEXT_PUBLIC_SHEETS_HMAC_SECRET;
  if (secret) {
    headers['X-REMS-Signature'] = `sha256=${await hmacHex(secret, body)}`;
  }

  await fetch(webhookUrl, { method: 'POST', headers, body });
}

/* ── Supabase Insert ─────────────────────────────────────────────────────── */

async function saveToSupabase(lead: Lead): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || supabaseUrl.includes('placeholder') || !supabaseKey || supabaseKey.includes('placeholder')) return;

  const res = await fetch(`${supabaseUrl}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      id:        lead.id,
      name:      lead.name,
      email:     lead.email,
      phone:     lead.phone || null,
      business:  lead.business || null,
      message:   lead.message || null,
      source:    lead.source,
      status:    lead.status,
      created_at: lead.createdAt,
    }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
}

/* ── Validation ──────────────────────────────────────────────────────────── */

export interface ValidationErrors {
  name?: string;
  email?: string;
  phone?: string;
}

export function validateLeadForm(data: Partial<Lead>): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!data.name?.trim()) errors.name = 'required';
  if (!data.email?.trim()) {
    errors.email = 'required';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.email = 'invalid';
  }
  if (data.phone && !/^[\d\s+\-()]{7,20}$/.test(data.phone)) {
    errors.phone = 'invalid';
  }
  return errors;
}

/* ── Main Submission Entry Point ─────────────────────────────────────────── */

/**
 * Lead IDs must be valid UUIDs — the Supabase `leads.id` column is `uuid`,
 * so a custom "lead-<ts>-<rand>" string makes the REST insert fail with HTTP 400.
 */
function newLeadId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c?.getRandomValues ? c.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function submitLead(
  data: { name: string; email: string; phone: string; business: string; message: string },
  source: LeadSource,
): Promise<SubmitResult> {
  const lead: Lead = {
    id:        newLeadId(),
    ...data,
    source,
    status:    'new',
    createdAt: new Date().toISOString(),
  };

  let lsOk = false, emailOk = false, sheetsOk = false, supabaseOk = false;

  // 1. localStorage — always first, never fails
  try { saveLead(lead); lsOk = true; } catch { /* ignore */ }

  // 2–4. Remote channels in parallel
  const [emailResult, sheetsResult, supabaseResult] = await Promise.allSettled([
    sendEmailJS(lead),
    logToSheets(lead),
    saveToSupabase(lead),
  ]);
  emailOk    = emailResult.status === 'fulfilled';
  sheetsOk   = sheetsResult.status === 'fulfilled';
  supabaseOk = supabaseResult.status === 'fulfilled';

  return {
    ok: lsOk,
    channels: { localStorage: lsOk, email: emailOk, sheets: sheetsOk, supabase: supabaseOk },
  };
}
