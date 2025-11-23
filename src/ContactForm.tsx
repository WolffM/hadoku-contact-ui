import { useState, FormEvent, ChangeEvent, ReactNode, useRef } from 'react'
import { format } from 'date-fns'
import { logger } from '@wolffm/task-ui-components'
import AppointmentPicker, { type AppointmentPickerRef } from './components/AppointmentPicker'
import { submitContactWithAppointment, AppointmentAPIError } from './api/appointments'
import type { FormData, FormErrors, SubmitStatus, AppointmentSelection } from './types'

interface ContactFormProps {
  themePicker?: ReactNode
}

export default function ContactForm({ themePicker }: ContactFormProps) {
  logger.component('update', 'ContactForm', { hasThemePicker: !!themePicker })
  const appointmentPickerRef = useRef<AppointmentPickerRef>(null)

  const [formData, setFormData] = useState<FormData>({
    name: '',
    email: '',
    message: '',
    website: '' // Honeypot field
  })

  const [status, setStatus] = useState<SubmitStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [appointmentSelection, setAppointmentSelection] = useState<AppointmentSelection>({
    date: null,
    duration: 15,
    selectedSlot: null,
    meetingPlatform: null
  })
  const [conflictError, setConflictError] = useState(false)
  const [bookedAppointment, setBookedAppointment] = useState<{
    date: Date
    startTime: string
    duration: number
    platform: string
  } | null>(null)

  // Field validators
  const validators = {
    name: (value: string): string | undefined => {
      if (!value || value.trim().length === 0) return 'Name is required'
      if (value.trim().length < 2) return 'Name must be at least 2 characters'
      return undefined
    },
    email: (value: string): string | undefined => {
      if (!value || value.trim().length === 0) return 'Email is required'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Please enter a valid email address'
      return undefined
    },
    message: (value: string): string | undefined => {
      if (!value || value.trim().length === 0) return 'Message is required'
      if (value.trim().length < 10) return 'Message must be at least 10 characters'
      return undefined
    }
  }

  // Validate form on client side
  const validateForm = (): boolean => {
    const newErrors: FormErrors = {}

    newErrors.name = validators.name(formData.name)
    newErrors.email = validators.email(formData.email)
    newErrors.message = validators.message(formData.message)

    // Appointment is optional, but if a date is selected, a slot and platform must be selected
    if (appointmentSelection.date && !appointmentSelection.selectedSlot) {
      newErrors.appointment = 'Please select a time slot or clear the date selection'
    }
    if (appointmentSelection.selectedSlot && !appointmentSelection.meetingPlatform) {
      newErrors.appointment = 'Please select a meeting platform'
    }

    // Filter out undefined errors
    Object.keys(newErrors).forEach(key => {
      if (newErrors[key as keyof FormErrors] === undefined) {
        delete newErrors[key as keyof FormErrors]
      }
    })

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    // Client-side validation
    if (!validateForm()) {
      return
    }

    setStatus('submitting')
    setErrorMessage('')
    setConflictError(false)

    try {
      // Build appointment data if selected
      const appointment =
        appointmentSelection.selectedSlot &&
        appointmentSelection.date &&
        appointmentSelection.meetingPlatform
          ? {
              slotId: appointmentSelection.selectedSlot.id,
              date: format(appointmentSelection.date, 'yyyy-MM-dd'),
              startTime: appointmentSelection.selectedSlot.startTime,
              endTime: appointmentSelection.selectedSlot.endTime,
              duration: appointmentSelection.duration,
              platform: appointmentSelection.meetingPlatform
            }
          : undefined

      const response = await submitContactWithAppointment({
        ...formData,
        appointment
      })

      if (response.success) {
        setStatus('success')
        // Store booked appointment details before clearing
        if (
          appointmentSelection.selectedSlot &&
          appointmentSelection.date &&
          appointmentSelection.meetingPlatform
        ) {
          setBookedAppointment({
            date: appointmentSelection.date,
            startTime: appointmentSelection.selectedSlot.startTime,
            duration: appointmentSelection.duration,
            platform: appointmentSelection.meetingPlatform
          })
        } else {
          setBookedAppointment(null)
        }
        // Keep name and email, clear only message
        setFormData(prev => ({ ...prev, message: '' }))
        // Clear selected slot but keep the date and platform preferences
        setAppointmentSelection(prev => ({
          ...prev,
          selectedSlot: null
        }))
        // Refresh available slots
        appointmentPickerRef.current?.refreshSlots()
      } else {
        setStatus('error')
        setErrorMessage(response.message || response.error || 'Failed to send message')
      }
    } catch (error) {
      setStatus('error')

      if (error instanceof AppointmentAPIError) {
        setErrorMessage(error.message)

        // Handle slot conflict - auto-refresh slots
        if (error.type === 'conflict' && error.updatedSlots) {
          setConflictError(true)
          // Trigger refresh via ref
          setTimeout(() => {
            appointmentPickerRef.current?.refreshSlots()
            setConflictError(false)
          }, 2000)
        }
      } else {
        setErrorMessage('Network error. Please check your connection and try again.')
      }
    }
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
    // Clear error for this field when user starts typing
    if (errors[name as keyof FormErrors]) {
      setErrors(prev => ({ ...prev, [name]: undefined }))
    }
  }

  const handleBlur = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target

    // Validate the field that just lost focus using the validators
    if (name in validators) {
      const error = validators[name as keyof typeof validators](value)
      setErrors(prev => ({
        ...prev,
        [name]: error
      }))
    }
  }

  // Check if form is valid for enabling submit button
  const isFormValid = (): boolean => {
    // Use validators to check each field
    const hasValidName = !validators.name(formData.name)
    const hasValidEmail = !validators.email(formData.email)
    const hasValidMessage = !validators.message(formData.message)

    // Basic fields must always be valid
    if (!hasValidName || !hasValidEmail || !hasValidMessage) {
      return false
    }

    // If user selected a slot, they must also select a platform
    if (appointmentSelection.selectedSlot && !appointmentSelection.meetingPlatform) {
      return false
    }

    // Date auto-selection doesn't count as starting the appointment flow
    // Only slot selection matters
    return true
  }

  return (
    <div className="contact-container">
      {/* Header */}
      <div className="contact-header">
        <div className="contact-header__title-row">
          <h1 className="contact-title">Get in Touch</h1>
          {themePicker && <div className="contact-header__theme-picker">{themePicker}</div>}
        </div>
        <p className="contact-subtitle">
          Have a question or want to work together? Send me a message!
        </p>
      </div>

      {/* Main content: Form (40%) + Appointment Picker (60%) */}
      <div className="contact-content">
        {/* Form Section */}
        <div className="contact-form-section">
          {/* Success Message */}
          {status === 'success' && (
            <div className="contact-alert contact-alert--success">
              <strong>Success! </strong>
              Your message has been sent
              {bookedAppointment && (
                <>
                  {' '}
                  and your meeting has been scheduled for{' '}
                  <strong>
                    {format(bookedAppointment.date, 'EEEE, MMMM d, yyyy')} at{' '}
                    {format(new Date(bookedAppointment.startTime), 'h:mm a')} (
                    {bookedAppointment.duration} minutes) via{' '}
                    {bookedAppointment.platform.charAt(0).toUpperCase() +
                      bookedAppointment.platform.slice(1)}
                  </strong>
                </>
              )}
              . I'll get back to you soon!
            </div>
          )}

          {/* Error Message */}
          {status === 'error' && errorMessage && (
            <div
              className={`contact-alert contact-alert--error ${conflictError ? 'contact-alert--conflict' : ''}`}
            >
              <strong>Error: </strong>
              {errorMessage}
              {conflictError && (
                <span className="contact-alert__refreshing"> Refreshing available slots...</span>
              )}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="contact-form">
            {/* Name field */}
            <div className="contact-field">
              <label htmlFor="name" className="contact-label">
                Name *
              </label>
              <input
                type="text"
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                onBlur={handleBlur}
                required
                className={`contact-input ${errors.name ? 'contact-input--error' : ''}`}
              />
              {errors.name && <span className="contact-error-text">{errors.name}</span>}
            </div>

            {/* Email field */}
            <div className="contact-field">
              <label htmlFor="email" className="contact-label">
                Email *
              </label>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                onBlur={handleBlur}
                required
                className={`contact-input ${errors.email ? 'contact-input--error' : ''}`}
              />
              {errors.email && <span className="contact-error-text">{errors.email}</span>}
            </div>

            {/* Message field */}
            <div className="contact-field">
              <label htmlFor="message" className="contact-label">
                Message *
              </label>
              <textarea
                id="message"
                name="message"
                value={formData.message}
                onChange={handleChange}
                onBlur={handleBlur}
                required
                rows={6}
                className={`contact-textarea ${errors.message ? 'contact-input--error' : ''}`}
              />
              {errors.message && <span className="contact-error-text">{errors.message}</span>}
            </div>

            {/* Appointment Error */}
            {errors.appointment && (
              <div className="contact-field-error">
                <span className="contact-error-text">{errors.appointment}</span>
              </div>
            )}

            {/* Honeypot field (hidden from humans, visible to bots) */}
            <input
              type="text"
              name="website"
              value={formData.website}
              onChange={handleChange}
              tabIndex={-1}
              autoComplete="off"
              className="contact-honeypot"
              aria-hidden="true"
            />

            {/* Submit button */}
            <button
              type="submit"
              disabled={status === 'submitting' || !isFormValid()}
              className="contact-button"
              onMouseEnter={() => {
                // Trigger validation to show errors when hovering disabled button
                if (!isFormValid() && status !== 'submitting') {
                  validateForm()
                }
              }}
            >
              {status === 'submitting'
                ? 'Sending...'
                : appointmentSelection.selectedSlot
                  ? 'Book Appointment & Send Message'
                  : 'Send Message'}
            </button>
          </form>
        </div>

        {/* Appointment Picker Section */}
        <div className="contact-appointment-section">
          <AppointmentPicker
            ref={appointmentPickerRef}
            onAppointmentChange={setAppointmentSelection}
            disabled={status === 'submitting'}
          />
        </div>
      </div>
    </div>
  )
}
