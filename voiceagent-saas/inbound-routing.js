export function normalizeDigits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

export function buildPhoneCandidates(value) {
  const digits = normalizeDigits(value);
  if (!digits) return [];
  const out = new Set([digits]);
  if (digits.startsWith("972")) out.add(`0${digits.slice(3)}`);
  if (digits.startsWith("0")) out.add(`972${digits.slice(1)}`);
  if (digits.startsWith("00")) out.add(digits.slice(2));
  return [...out];
}

export function parseDidCandidatesFromChannel(channel = {}) {
  const candidates = new Set();
  const push = (raw) => {
    for (const candidate of buildPhoneCandidates(raw)) candidates.add(candidate);
  };
  push(channel?.dialplan?.exten);
  push(channel?.dialed?.number);
  push(channel?.dialed?.exten);
  push(channel?.connected?.number);
  const name = String(channel?.name || "");
  for (const match of name.match(/\d{7,15}/g) || []) push(match);
  return [...candidates];
}

export async function findPhoneNumberRoute(db, channel = {}) {
  if (!db) return null;
  const didCandidates = parseDidCandidatesFromChannel(channel);
  if (!didCandidates.length) return null;
  const { data, error } = await db
    .from("phone_numbers")
    .select("id, tenant_id, phone_number, default_campaign_id")
    .in("phone_number", didCandidates)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function getActiveCampaignById(db, tenantId, campaignId) {
  if (!campaignId) return null;
  const { data, error } = await db
    .from("campaigns")
    .select("id, tenant_id, status")
    .eq("id", campaignId)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function getSystemDefaultRoute(db, log = console) {
  if (!db) return null;
  const { data: tenants, error: tenantError } = await db
    .from("tenants")
    .select("id")
    .eq("is_system_default", true)
    .limit(1);
  if (tenantError) throw tenantError;
  const tenantId = tenants?.[0]?.id;
  if (!tenantId) return null;

  const { data: campaigns, error: campaignError } = await db
    .from("campaigns")
    .select("id, tenant_id, status")
    .eq("is_system_default", true)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .limit(1);
  if (campaignError) throw campaignError;
  const campaign = campaigns?.[0] || null;
  if (!campaign) {
    log?.warn?.({ tenantId }, "System default tenant has no active system default campaign");
  }
  return { tenantId, campaignId: campaign?.id || null };
}

export async function findOrCreateInboundContact(db, tenantId, callerNumber) {
  const candidates = buildPhoneCandidates(callerNumber);
  const query = db
    .from("contacts")
    .select("id, tenant_id, phone, name, custom_fields")
    .eq("tenant_id", tenantId);
  if (candidates.length) query.in("phone", candidates);
  const { data: existing, error: findError } = await query.limit(1);
  if (findError) throw findError;
  if (existing?.[0]) return existing[0];

  const normalized = candidates[0] || normalizeDigits(callerNumber) || "unknown";

  try {
    const { data: created, error: upsertError } = await db
      .from("contacts")
      .upsert({
        tenant_id: tenantId,
        phone: normalized,
        name: `Inbound lead ${normalized !== "unknown" ? normalized.slice(-4) : "unknown"}`,
        custom_fields: { source: "inbound_call" },
      }, { onConflict: "tenant_id,phone" })
      .select("id, tenant_id, phone, name, custom_fields")
      .single();
    
    if (upsertError) throw upsertError;
    return created;
  } catch (err) {
    // If upsert fails for any reason, fallback to select one last time
    const { data: doubleCheck, error: checkErr } = await db
      .from("contacts")
      .select("id, tenant_id, phone, name, custom_fields")
      .eq("tenant_id", tenantId)
      .eq("phone", normalized)
      .single();
      
    if (doubleCheck) return doubleCheck;
    throw err;
  }
}

export async function resolveInboundCampaignId(db, tenantId, contactId, didDefaultCampaignId, log = console) {
  const { data: recentCalls, error: recentError } = await db
    .from("calls")
    .select("campaign_id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .not("campaign_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);
  if (recentError) throw recentError;

  for (const recentCall of recentCalls || []) {
    const campaign = await getActiveCampaignById(db, tenantId, recentCall.campaign_id);
    if (campaign) return campaign.id;
    log?.warn?.(
      { tenantId, contactId, campaignId: recentCall.campaign_id },
      "Ignoring inactive or cross-tenant recent inbound campaign candidate",
    );
  }

  if (didDefaultCampaignId) {
    const campaign = await getActiveCampaignById(db, tenantId, didDefaultCampaignId);
    if (campaign) return campaign.id;
    log?.warn?.(
      { tenantId, campaignId: didDefaultCampaignId },
      "Ignoring inactive or cross-tenant DID default campaign",
    );
  }

  const { data: campaigns, error: campaignError } = await db
    .from("campaigns")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);
  if (campaignError) throw campaignError;
  return campaigns?.[0]?.id || null;
}
