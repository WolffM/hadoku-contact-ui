/**
 * Rate limiting for contact-api
 *
 * Sliding window implementation using Cloudflare KV.
 */

import { RATE_LIMIT_CONFIG } from './constants'

export interface RateLimitConfig {
  maxRequests: number
  windowSeconds: number
  kvTtlSeconds: number
  keyPrefix?: string
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
  reason?: string
}

interface RateLimitEntry {
  count: number
  windowStart: number
}

async function sharedCheckRateLimit(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const prefix = config.keyPrefix ?? 'rate-limit'
  const key = `${prefix}:${identifier}`
  const windowMs = config.windowSeconds * 1000
  const now = Date.now()

  const existingData = await kv.get(key, 'text')
  const existing: RateLimitEntry | null = existingData
    ? (JSON.parse(existingData) as RateLimitEntry)
    : null

  if (!existing || now - existing.windowStart >= windowMs) {
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetAt: now + windowMs
    }
  }

  if (existing.count >= config.maxRequests) {
    const resetAt = existing.windowStart + windowMs
    const timeRemaining = resetAt - now
    const display =
      timeRemaining >= 120_000
        ? `${Math.ceil(timeRemaining / 60_000)} minute(s)`
        : `${Math.ceil(timeRemaining / 1000)} second(s)`

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      reason: `Rate limit exceeded. Try again in ${display}.`
    }
  }

  return {
    allowed: true,
    remaining: config.maxRequests - existing.count - 1,
    resetAt: existing.windowStart + windowMs
  }
}

async function recordRequest(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig
): Promise<void> {
  const prefix = config.keyPrefix ?? 'rate-limit'
  const key = `${prefix}:${identifier}`
  const windowMs = config.windowSeconds * 1000
  const now = Date.now()

  const existingData = await kv.get(key, 'text')
  const existing: RateLimitEntry | null = existingData
    ? (JSON.parse(existingData) as RateLimitEntry)
    : null

  let entry: RateLimitEntry

  if (!existing || now - existing.windowStart >= windowMs) {
    entry = { count: 1, windowStart: now }
  } else {
    entry = { count: existing.count + 1, windowStart: existing.windowStart }
  }

  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: config.kvTtlSeconds
  })
}

export async function resetRateLimit(
  kv: KVNamespace,
  identifier: string,
  config?: { keyPrefix?: string }
): Promise<void> {
  const prefix = config?.keyPrefix ?? 'rate-limit'
  const key = `${prefix}:${identifier}`
  await kv.delete(key)
}

function makeConfig(overrides?: {
  maxSubmissionsPerHour?: number
  windowDurationSeconds?: number
}): RateLimitConfig {
  return {
    maxRequests: overrides?.maxSubmissionsPerHour ?? RATE_LIMIT_CONFIG.MAX_SUBMISSIONS_PER_HOUR,
    windowSeconds: overrides?.windowDurationSeconds ?? RATE_LIMIT_CONFIG.WINDOW_DURATION_SECONDS,
    kvTtlSeconds: overrides?.windowDurationSeconds ?? RATE_LIMIT_CONFIG.KV_TTL_SECONDS
  }
}

export async function checkRateLimit(
  kv: KVNamespace,
  ipAddress: string,
  overrides?: { maxSubmissionsPerHour?: number; windowDurationSeconds?: number }
): Promise<RateLimitResult> {
  return sharedCheckRateLimit(kv, ipAddress, makeConfig(overrides))
}

export async function recordSubmission(
  kv: KVNamespace,
  ipAddress: string,
  overrides?: { maxSubmissionsPerHour?: number; windowDurationSeconds?: number }
): Promise<void> {
  return recordRequest(kv, ipAddress, makeConfig(overrides))
}

export async function getRateLimitStatus(
  kv: KVNamespace,
  ipAddress: string,
  overrides?: { maxSubmissionsPerHour?: number; windowDurationSeconds?: number }
): Promise<RateLimitResult> {
  return sharedCheckRateLimit(kv, ipAddress, makeConfig(overrides))
}
