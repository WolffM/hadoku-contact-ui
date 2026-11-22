/**
 * A booking's calendar mirror goes to task-api through the EDGE_ROUTER binding,
 * and its outcome is reported as a `calendar_mirror` telemetry event.
 *
 * The 2026-11-21 booking's mirror left no /task/api request and no record of
 * why. These pin that the outcome is now always written down, both ways.
 */
import { env, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import worker from '../../test-entry'
import { __resetCalendarBoardCache } from '../../services/task-calendar'
import type { ContactEnv } from '../../types'

interface Seen {
  method: string
  path: string
  body: string
}

/** edge-router stand-in: task-api answers `createStatus`, telemetry is recorded. */
function edgeRouter(createStatus: number) {
  const seen: Seen[] = []
  const binding = {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      const path = new URL(req.url).pathname
      seen.push({ method: req.method, path, body: await req.text() })
      if (path === '/task/api/boards') {
        return Response.json({ boards: [{ id: 'owner~main', access: 'contributor' }] })
      }
      if (path === '/task/api') {
        return new Response(createStatus === 200 ? '{}' : 'task-api down', {
          status: createStatus
        })
      }
      return Response.json({ success: true })
    }
  } as unknown as Fetcher
  const events = () =>
    seen
      .filter(s => s.path === '/health/api/telemetry')
      .map(s => (JSON.parse(s.body) as { message: string; level: string }).message)
  return { binding, seen, events }
}

function nextUtcWeekday(targetDay: number, minDaysOut = 5): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + minDaysOut)
  d.setUTCDate(d.getUTCDate() + ((targetDay - d.getUTCDay() + 7) % 7))
  return d.toISOString().split('T')[0]
}

async function book(router: Fetcher) {
  fetchMock
    .get('https://api.resend.com')
    .intercept({ path: '/emails', method: 'POST' })
    .reply(200, JSON.stringify({ id: 're_mirror' }), {
      headers: { 'Content-Type': 'application/json' }
    })

  const date = nextUtcWeekday(3, 5)
  const startTime = `${date}T18:00:00.000Z`
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request('https://test.com/contact/api/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.99',
        Referer: 'https://hadoku.me/contact'
      },
      body: JSON.stringify({
        name: 'Ruben',
        email: 'ruben@forest-ai.org',
        message: 'Recruiting',
        recipient: 'matthaeus@hadoku.me',
        appointment: {
          slotId: `slot-${date}-${startTime}`,
          date,
          startTime,
          endTime: `${date}T18:30:00.000Z`,
          duration: 30,
          platform: 'jitsi'
        }
      })
    }),
    {
      ...(env as unknown as ContactEnv),
      HADOKU_SERVICE_KEY: 'contact-service-key',
      EDGE_ROUTER: router
    },
    ctx
  )
  await waitOnExecutionContext(ctx)
  expect(res.status).toBe(201)
  const { appointmentId } = (await res.json()) as { appointmentId: string }
  return appointmentId
}

describe('calendar mirror telemetry', () => {
  beforeEach(() => {
    __resetCalendarBoardCache()
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors()
    fetchMock.deactivate()
  })

  it('mirrors through EDGE_ROUTER and reports ok', async () => {
    const router = edgeRouter(200)
    const id = await book(router.binding)

    expect(router.seen.map(s => `${s.method} ${s.path}`)).toEqual(
      expect.arrayContaining(['GET /task/api/boards', 'POST /task/api'])
    )
    expect(router.events()).toContain(`event=contact.calendar_mirror ok appointment:${id} HTTP 200`)
  })

  it('reports a refused mirror with its status', async () => {
    const router = edgeRouter(500)
    const id = await book(router.binding)

    expect(router.events()).toContain(
      `event=contact.calendar_mirror failed appointment:${id} HTTP 500 task-api down`
    )
  })
})
