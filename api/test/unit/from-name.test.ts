/**
 * The outbound display name.
 *
 * This is the most prominent thing in a recipient's inbox list and frequently
 * the only thing read before deciding whether to open. It shipped for the life
 * of the project as the literal 'Hadoku Mail', hardcoded separately in two
 * providers — so a reply from a person announced itself as a brand, and fixing
 * it meant editing two files that could disagree.
 *
 * Pinned because it is exactly the kind of string that regresses silently: no
 * test fails, no type breaks, and nobody notices until a recruiter sees it.
 */
import { describe, it, expect } from 'vitest'
import { EMAIL_CONFIG } from '../../constants'
import { ResendProvider } from '../../email/resend'
import { MailChannelsProvider } from '../../email/mailchannels'

/** Capture the outgoing request body without hitting the network. */
async function captureBody(send: (f: typeof fetch) => Promise<unknown>) {
  let captured: Record<string, unknown> = {}
  const fake = (async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 })
  }) as unknown as typeof fetch
  const original = globalThis.fetch
  globalThis.fetch = fake
  try {
    await send(fake)
  } finally {
    globalThis.fetch = original
  }
  return captured
}

const params = {
  from: 'matthaeus@hadoku.me',
  to: 'someone@example.com',
  subject: 's',
  text: 't'
}

describe('outbound display name', () => {
  it('defaults to the configured name, not a brand string', async () => {
    expect(EMAIL_CONFIG.DEFAULT_FROM_NAME).toBe('Matthaeus Wolff')
    expect(EMAIL_CONFIG.DEFAULT_FROM_NAME).not.toMatch(/hadoku/i)
  })

  it('Resend sends `Name <address>` using the default', async () => {
    const body = await captureBody(() => new ResendProvider('k').sendEmail(params))
    expect(body.from).toBe(`${EMAIL_CONFIG.DEFAULT_FROM_NAME} <matthaeus@hadoku.me>`)
  })

  it('MailChannels uses the same default', async () => {
    const body = await captureBody(() => new MailChannelsProvider().sendEmail(params))
    expect((body.from as { name: string }).name).toBe(EMAIL_CONFIG.DEFAULT_FROM_NAME)
  })

  it('both providers honour a per-message override', async () => {
    const resend = await captureBody(() =>
      new ResendProvider('k').sendEmail({ ...params, fromName: 'Override Name' })
    )
    expect(resend.from).toBe('Override Name <matthaeus@hadoku.me>')

    const mc = await captureBody(() =>
      new MailChannelsProvider().sendEmail({ ...params, fromName: 'Override Name' })
    )
    expect((mc.from as { name: string }).name).toBe('Override Name')
  })
})
