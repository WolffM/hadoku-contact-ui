# API Implementation Guide for Parent Application

This document provides comprehensive instructions for implementing the backend API that the Contact UI component requires.

## Overview

The Contact UI micro-frontend requires two API endpoints:

1. **GET /contact/api/appointments/slots** - Fetch available time slots
2. **POST /contact/api/submit** - Submit contact form with optional appointment

## Type Exports

All necessary types are exported from the package entry point. Import them as follows:

```typescript
import {
  // Form types
  FormData,
  FormErrors,
  SubmitStatus,

  // Appointment types
  TimeSlotDuration,
  MeetingPlatform,
  AppointmentSlot,
  AppointmentSelection,

  // API types
  FetchSlotsRequest,
  FetchSlotsResponse,
  SubmitContactRequest,
  SubmitContactResponse,
  AppointmentError,

  // Component types
  ContactUIProps
} from '@wolffm/contact-ui'
```

## API Endpoints

### 1. Fetch Available Slots

**Endpoint**: `GET /contact/api/appointments/slots`

**Query Parameters**:

- `date` (string, required): Date in `YYYY-MM-DD` format
- `duration` (number, required): Slot duration in minutes (15, 30, or 60)

**Request Example**:

```http
GET /contact/api/appointments/slots?date=2025-11-21&duration=30
```

**Success Response** (200 OK):

```typescript
{
  date: "2025-11-21",
  duration: 30,
  timezone: "America/Los_Angeles",
  slots: [
    {
      id: "slot-unique-id-1",
      startTime: "2025-11-21T09:00:00.000Z",
      endTime: "2025-11-21T09:30:00.000Z",
      available: true
    },
    {
      id: "slot-unique-id-2",
      startTime: "2025-11-21T09:30:00.000Z",
      endTime: "2025-11-21T10:00:00.000Z",
      available: false
    }
    // ... more slots
  ]
}
```

**Response Type**:

```typescript
interface FetchSlotsResponse {
  date: string // YYYY-MM-DD
  duration: TimeSlotDuration // 15 | 30 | 60
  slots: AppointmentSlot[]
  timezone: string // IANA timezone identifier
}

interface AppointmentSlot {
  id: string // Unique identifier for this slot
  startTime: string // ISO 8601 format
  endTime: string // ISO 8601 format
  available: boolean // Whether slot can be booked
}
```

**Error Responses**:

- **429 Too Many Requests** - Rate limiting

```json
{
  "message": "Too many requests. Please try again later."
}
```

- **400 Bad Request** - Invalid parameters

```json
{
  "message": "Invalid date format or duration"
}
```

- **500 Internal Server Error** - Server error

```json
{
  "message": "Failed to fetch available slots"
}
```

**Business Logic Requirements**:

1. Only return slots for dates at least 24 hours in the future
2. Generate slots based on your business hours (e.g., 9 AM - 5 PM)
3. Check actual calendar/booking system for availability
4. Each slot must have a unique ID that can be referenced during booking
5. Times must be in ISO 8601 format
6. Include timezone information for proper time display

### 2. Submit Contact Form

**Endpoint**: `POST /contact/api/submit`

**Request Headers**:

```http
Content-Type: application/json
```

**Request Body**:

```typescript
{
  name: string         // Required, min 2 characters
  email: string        // Required, valid email format
  message: string      // Required, min 10 characters
  website: string      // Honeypot field - should always be empty
  appointment?: {      // Optional - only if booking appointment
    slotId: string     // Must match a slot ID from fetch slots
    date: string       // YYYY-MM-DD
    startTime: string  // ISO 8601
    endTime: string    // ISO 8601
    duration: TimeSlotDuration  // 15 | 30 | 60
    platform: MeetingPlatform  // 'discord' | 'google' | 'teams' | 'jitsi'
  }
}
```

**Request Type**:

```typescript
interface SubmitContactRequest {
  name: string
  email: string
  message: string
  website: string // Honeypot - reject if not empty
  appointment?: {
    slotId: string
    date: string
    startTime: string
    endTime: string
    duration: TimeSlotDuration
    platform: MeetingPlatform
  }
}

type TimeSlotDuration = 15 | 30 | 60
type MeetingPlatform = 'discord' | 'google' | 'teams' | 'jitsi'
```

**Success Response** (200 OK):

```typescript
{
  success: true,
  message: "Your message has been sent and appointment booked!"
}
```

**Response Type**:

```typescript
interface SubmitContactResponse {
  success: boolean
  message?: string // Success or error message
  error?: string // Deprecated - use message instead
  errors?: string[] // Multiple validation errors
  conflict?: {
    // Only on 409 or 429
    reason: 'slot_taken' | 'rate_limit' | 'invalid_slot'
    updatedSlots?: AppointmentSlot[] // New slots on slot_taken
  }
}
```

**Error Responses**:

- **400 Bad Request** - Spam detected (honeypot) or validation errors

```json
{
  "success": false,
  "message": "Spam detected",
  "errors": ["Invalid email format", "Message too short"]
}
```

- **409 Conflict** - Slot was just taken by another user

```json
{
  "success": false,
  "message": "This time slot was just booked",
  "conflict": {
    "reason": "slot_taken",
    "updatedSlots": [
      {
        "id": "slot-new-1",
        "startTime": "2025-11-21T10:00:00.000Z",
        "endTime": "2025-11-21T10:30:00.000Z",
        "available": true
      }
      // ... other available slots
    ]
  }
}
```

- **429 Too Many Requests** - Rate limiting

```json
{
  "success": false,
  "message": "Too many booking attempts. Please try again later.",
  "conflict": {
    "reason": "rate_limit"
  }
}
```

- **500 Internal Server Error** - Server error

```json
{
  "success": false,
  "message": "Failed to submit contact form"
}
```

**Business Logic Requirements**:

1. **Honeypot Check**:
   - If `website` field is not empty, reject as spam (400)
   - This field is hidden with CSS and only bots fill it

2. **Validation**:
   - Name: min 2 characters
   - Email: valid email format
   - Message: min 10 characters
   - If appointment included, all appointment fields required

3. **Slot Conflict Handling**:
   - Before booking, verify slot is still available
   - If slot was taken, return 409 with updated available slots
   - Include only available slots in updatedSlots array
   - Frontend will automatically refresh with new slots

4. **Rate Limiting**:
   - Implement rate limiting per IP or user
   - Return 429 with appropriate retry-after information
   - Frontend handles retry logic with user messaging

5. **Appointment Creation**:
   - Create calendar event in your booking system
   - Generate meeting link based on platform:
     - Discord: Discord server invite or channel link
     - Google: Google Meet link
     - Teams: Microsoft Teams meeting link
     - Jitsi: Jitsi Meet room URL
   - Send confirmation email to user with meeting details
   - Include meeting link, time, and calendar invite

6. **Transaction Safety**:
   - Use database transactions for slot booking
   - Lock slot record during booking to prevent double-booking
   - Validate slot is available within transaction

7. **Email Notifications**:
   - Send confirmation email to user
   - Include appointment details if booked
   - Provide meeting link and calendar invite (ICS file)

## Implementation Examples

### Example: Node.js/Express Backend

```typescript
import express from 'express'
import type {
  FetchSlotsResponse,
  SubmitContactRequest,
  SubmitContactResponse
} from '@wolffm/contact-ui'

const app = express()
app.use(express.json())

// Fetch available slots
app.get('/contact/api/appointments/slots', async (req, res) => {
  const { date, duration } = req.query

  // Validate inputs
  if (!date || !duration) {
    return res.status(400).json({ message: 'Missing required parameters' })
  }

  try {
    // Query your calendar/booking system
    const slots = await yourCalendarService.getAvailableSlots(
      date as string,
      parseInt(duration as string)
    )

    const response: FetchSlotsResponse = {
      date: date as string,
      duration: parseInt(duration as string) as 15 | 30 | 60,
      slots,
      timezone: 'America/Los_Angeles'
    }

    res.json(response)
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch slots' })
  }
})

// Submit contact form
app.post('/contact/api/submit', async (req, res) => {
  const request: SubmitContactRequest = req.body

  // Honeypot check
  if (request.website) {
    return res.status(400).json({
      success: false,
      message: 'Spam detected'
    })
  }

  // Validate fields
  const errors: string[] = []
  if (!request.name || request.name.length < 2) {
    errors.push('Name must be at least 2 characters')
  }
  if (!request.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email)) {
    errors.push('Invalid email format')
  }
  if (!request.message || request.message.length < 10) {
    errors.push('Message must be at least 10 characters')
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      errors
    })
  }

  try {
    // If appointment included, book it
    if (request.appointment) {
      // Check if slot is still available
      const slotAvailable = await yourCalendarService.checkSlotAvailability(
        request.appointment.slotId
      )

      if (!slotAvailable) {
        // Get updated slots
        const updatedSlots = await yourCalendarService.getAvailableSlots(
          request.appointment.date,
          request.appointment.duration
        )

        return res.status(409).json({
          success: false,
          message: 'This time slot was just booked',
          conflict: {
            reason: 'slot_taken',
            updatedSlots: updatedSlots.filter(s => s.available)
          }
        } as SubmitContactResponse)
      }

      // Book the slot
      await yourCalendarService.bookSlot(request.appointment)

      // Generate meeting link based on platform
      const meetingLink = await generateMeetingLink(
        request.appointment.platform,
        request.appointment
      )

      // Send confirmation email with meeting link
      await sendConfirmationEmail(request, meetingLink)
    } else {
      // Just send contact form notification
      await sendContactNotification(request)
    }

    const response: SubmitContactResponse = {
      success: true,
      message: request.appointment
        ? 'Your message has been sent and appointment booked!'
        : 'Your message has been sent!'
    }

    res.json(response)
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to submit contact form'
    })
  }
})

async function generateMeetingLink(platform: MeetingPlatform, appointment: any): Promise<string> {
  switch (platform) {
    case 'google':
      return await createGoogleMeetLink(appointment)
    case 'teams':
      return await createTeamsMeetingLink(appointment)
    case 'discord':
      return 'https://discord.gg/your-server'
    case 'jitsi':
      return `https://meet.jit.si/appointment-${appointment.slotId}`
  }
}
```

## Testing with Mock API

During development, the Contact UI automatically uses mock APIs when:

- `import.meta.env.DEV` is true (development mode)
- OR `VITE_USE_MOCK_API=true` in `.env`

The mock API simulates:

- Available and unavailable time slots
- Slot conflicts (10% chance)
- Rate limiting (5% chance)
- Honeypot spam detection
- Network delays (800ms)

You can test your integration without implementing the backend first.

## Error Handling

The Contact UI handles all error scenarios automatically:

- Network errors: Shows retry option
- Slot conflicts: Auto-refreshes slots and shows user message
- Rate limiting: Shows appropriate message
- Validation errors: Displays field-level errors

Ensure your API returns proper HTTP status codes and error messages for best UX.

## Security Considerations

1. **Honeypot**: Always check `website` field and reject if not empty
2. **Rate Limiting**: Implement per-IP rate limiting to prevent abuse
3. **Input Validation**: Validate all inputs on server side
4. **SQL Injection**: Use parameterized queries
5. **CORS**: Configure CORS properly if Contact UI hosted separately
6. **Authentication**: Consider requiring auth for booking appointments
7. **Email Validation**: Consider email verification before sending meeting links

## Calendar Integration Examples

### Google Calendar API

```typescript
import { google } from 'googleapis'

async function createGoogleCalendarEvent(appointment: Appointment) {
  const calendar = google.calendar({ version: 'v3', auth })

  const event = {
    summary: `Meeting with ${appointment.name}`,
    description: appointment.message,
    start: { dateTime: appointment.startTime },
    end: { dateTime: appointment.endTime },
    conferenceData: {
      createRequest: {
        requestId: appointment.slotId,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    attendees: [{ email: appointment.email }]
  }

  const result = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
    conferenceDataVersion: 1
  })

  return result.data.hangoutLink
}
```

### Microsoft Graph API (Teams)

```typescript
import { Client } from '@microsoft/microsoft-graph-client'

async function createTeamsMeeting(appointment: Appointment) {
  const client = Client.init({ authProvider })

  const meeting = {
    startDateTime: appointment.startTime,
    endDateTime: appointment.endTime,
    subject: `Meeting with ${appointment.name}`,
    participants: {
      attendees: [{ emailAddress: { address: appointment.email } }]
    }
  }

  const result = await client.api('/me/onlineMeetings').post(meeting)

  return result.joinUrl
}
```

## Support

For questions or issues with the Contact UI integration:

- GitHub: <https://github.com/wolffm/contact-ui>
- Documentation: See other files in `/docs` directory
