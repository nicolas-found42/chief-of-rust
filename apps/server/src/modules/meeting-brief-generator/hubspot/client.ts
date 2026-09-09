import type { HubSpotCompany, HubSpotContact, HubSpotDeal } from "@chief-of-staff-demo/shared";

export interface HubSpotApi {
  /** Bounded read-only probe: list 1 contact, no side effect. */
  listContacts(limit: number): Promise<{ results: Array<{ id: string }> }>;
  /** Exact-email contact lookup — case-sensitive per HubSpot, caller normalizes. */
  searchContactByEmail(email: string): Promise<HubSpotContact | null>;
  /** Explicit associations from a contact to companies (max 10). */
  getAssociatedCompanyIds(contactId: string): Promise<string[]>;
  getCompany(companyId: string): Promise<HubSpotCompany | null>;
  /** Explicit associations from contact or company to deals (max 10). */
  getAssociatedDealIds(contactId: string): Promise<string[]>;
  getDeal(dealId: string): Promise<HubSpotDeal | null>;
  getAssociatedDealIdsForCompany(companyId: string): Promise<string[]>;
}

type FetchLike = typeof fetch;

interface HubSpotErrorShape {
  status: number;
  category: string | undefined;
  message: string;
}

function hubSpotError(
  status: number,
  category: string | undefined,
  message: string,
): HubSpotErrorShape & Error {
  const error = new Error(message) as HubSpotErrorShape & Error;
  (error as HubSpotErrorShape).status = status;
  (error as HubSpotErrorShape).category = category;
  (error as HubSpotErrorShape).message = message;
  return error;
}

async function hubSpotFetch(
  token: string,
  url: string,
  init: RequestInit & { fetchImpl?: FetchLike },
): Promise<Response> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let category: string | undefined;
    let message = `HubSpot ${response.status}`;
    try {
      const body = (await response.json()) as {
        category?: string;
        message?: string;
        status?: string;
      };
      category = body.category;
      if (body.message) message = body.message;
    } catch {
      // keep generic message, try text
      try {
        const text = await response.text();
        if (text) message = text.slice(0, 500);
      } catch {
        // ignore
      }
    }
    throw hubSpotError(response.status, category, message);
  }
  return response;
}

export function hubSpotApi(token: string, fetchImpl: FetchLike = fetch): HubSpotApi {
  const base = "https://api.hubapi.com";

  return {
    async listContacts(limit: number) {
      const url = `${base}/crm/v3/objects/contacts?limit=${limit}&archived=false&properties=email`;
      const response = await hubSpotFetch(token, url, { method: "GET", fetchImpl });
      const body = (await response.json()) as { results?: Array<{ id: string }> };
      return { results: body.results ?? [] };
    },

    async searchContactByEmail(email: string) {
      const url = `${base}/crm/v3/objects/contacts/search`;
      const body = {
        filterGroups: [
          {
            filters: [{ propertyName: "email", operator: "EQ", value: email }],
          },
        ],
        limit: 1,
        properties: ["email", "firstname", "lastname", "company", "hs_object_id"],
        sorts: [],
      };
      const response = await hubSpotFetch(token, url, {
        method: "POST",
        body: JSON.stringify(body),
        fetchImpl,
      });
      const data = (await response.json()) as {
        total?: number;
        results?: Array<{
          id: string;
          properties: Record<string, string>;
        }>;
      };
      const hit = data.results?.[0];
      if (!hit) return null;
      // Follow explicit associations to companies/deals bounded (callers fetch those).
      const contact: HubSpotContact = {
        id: hit.id,
        email: hit.properties.email ?? email,
        properties: hit.properties,
        associatedCompanyIds: [],
        associatedDealIds: [],
      };
      // Associations are fetched separately via association endpoints.
      // For now return contact without pre-filled associations; callers use
      // getAssociatedCompanyIds etc.
      return contact;
    },

    async getAssociatedCompanyIds(contactId: string) {
      const url = `${base}/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/companies`;
      const response = await hubSpotFetch(token, url, { method: "GET", fetchImpl });
      const data = (await response.json()) as { results?: Array<{ toObjectId: number | string }> };
      const ids = (data.results ?? []).map((r) => String(r.toObjectId)).slice(0, 10);
      return ids;
    },

    async getCompany(companyId: string) {
      const url = `${base}/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=name,domain,hs_object_id`;
      const response = await hubSpotFetch(token, url, { method: "GET", fetchImpl });
      const data = (await response.json()) as { id: string; properties: Record<string, string> };
      return {
        id: data.id,
        name: data.properties.name ?? "",
        domain: data.properties.domain ?? null,
        properties: data.properties,
      };
    },

    async getAssociatedDealIds(contactId: string) {
      const url = `${base}/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/deals`;
      const response = await hubSpotFetch(token, url, { method: "GET", fetchImpl });
      const data = (await response.json()) as { results?: Array<{ toObjectId: number | string }> };
      const ids = (data.results ?? []).map((r) => String(r.toObjectId)).slice(0, 10);
      return ids;
    },

    async getAssociatedDealIdsForCompany(companyId: string) {
      const url = `${base}/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/deals`;
      const response = await hubSpotFetch(token, url, { method: "GET", fetchImpl });
      const data = (await response.json()) as { results?: Array<{ toObjectId: number | string }> };
      const ids = (data.results ?? []).map((r) => String(r.toObjectId)).slice(0, 10);
      return ids;
    },

    async getDeal(dealId: string) {
      const url = `${base}/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealname,amount,dealstage,hs_object_id`;
      const response = await hubSpotFetch(token, url, { method: "GET", fetchImpl });
      const data = (await response.json()) as { id: string; properties: Record<string, string> };
      return {
        id: data.id,
        name: data.properties.dealname ?? null,
        amount: data.properties.amount ?? null,
        stage: data.properties.dealstage ?? null,
        properties: data.properties,
      };
    },
  };
}
