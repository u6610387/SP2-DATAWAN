/**
 * POST /webhook — verify signature on the RAW body, dedupe by webhookEventId, route each event.
 * Reply-critical work runs inline (reply tokens are short-lived). One bad event never fails the batch.
 */
import type { webhook } from '@line/bot-sdk';
import type { Deps } from '../deps';
import { handleCustomerEvent } from '../handlers/customer';
import { handleOwnerEvent } from '../handlers/owner';
import { verifyLineSignature } from '../line/signature';

export async function handleWebhook(deps: Deps, rawBody: string, signature: string | null): Promise<Response> {
  if (!(await verifyLineSignature(rawBody, signature, deps.cfg.LINE_CHANNEL_SECRET))) {
    return new Response('bad signature', { status: 401 });
  }
  let body: webhook.CallbackRequest;
  try {
    body = JSON.parse(rawBody) as webhook.CallbackRequest;
  } catch {
    return new Response('bad json', { status: 400 });
  }
  for (const ev of body.events ?? []) {
    try {
      if (!(await deps.repo.markLineEvent(ev.webhookEventId))) continue; // redelivery
      await routeEvent(deps, ev);
    } catch (e) {
      console.error('[webhook] event failed', ev.type, (e as Error).message);
    }
  }
  return new Response('ok');
}

export async function routeEvent(deps: Deps, ev: webhook.Event): Promise<void> {
  const source = ev.source;
  if (!source || source.type !== 'user' || !source.userId) return; // groups/rooms not supported
  if (source.userId === deps.cfg.LINE_OWNER_USER_ID) return handleOwnerEvent(deps, ev);
  return handleCustomerEvent(deps, ev, source.userId);
}
