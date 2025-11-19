import { useState, FormEvent, ChangeEvent } from 'react'

interface ContactFormProps {
  basename?: string
  environment?: string
}

interface FormData {
  name: string
  email: string
  message: string
  website: string // Honeypot
}

interface FormErrors {
  name?: string
  email?: string
  message?: string
}

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error'

export default function ContactForm({ basename: _basename = '/contact' }: ContactFormProps) {
  const [formData, setFormData] = useState<FormData>({
    name: '',
    email: '',
    message: '',
    website: '' // Honeypot field
  })

  const [status, setStatus] = useState<SubmitStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})

  // Validate form on client side
  const validateForm = (): boolean => {
    const newErrors: FormErrors = {}

    if (!formData.name || formData.name.trim().length < 2) {
      newErrors.name = 'Name must be at least 2 characters'
    }

    if (!formData.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address'
    }

    if (!formData.message || formData.message.trim().length < 10) {
      newErrors.message = 'Message must be at least 10 characters'
    }

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

    try {
      const response = await fetch('/contact/api/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
      })

      const data = await response.json()

      if (response.ok && data.success) {
        setStatus('success')
        setFormData({ name: '', email: '', message: '', website: '' })
      } else {
        setStatus('error')
        if (data.errors && Array.isArray(data.errors)) {
          setErrorMessage(data.errors.join(', '))
        } else {
          setErrorMessage(data.message || data.error || 'Failed to send message')
        }
      }
    } catch {
      setStatus('error')
      setErrorMessage('Network error. Please check your connection and try again.')
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

  return (
    <div className="contact-container">
      {/* Header */}
      <div className="contact-header">
        <h1 className="contact-title">Get in Touch</h1>
        <p className="contact-subtitle">
          Have a question or want to work together? Send me a message!
        </p>
      </div>

      {/* Success Message */}
      {status === 'success' && (
        <div className="contact-alert contact-alert--success">
          <strong>Success! </strong>
          Your message has been sent. I'll get back to you soon!
        </div>
      )}

      {/* Error Message */}
      {status === 'error' && errorMessage && (
        <div className="contact-alert contact-alert--error">
          <strong>Error: </strong>
          {errorMessage}
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
            required
            rows={6}
            className={`contact-textarea ${errors.message ? 'contact-input--error' : ''}`}
          />
          {errors.message && <span className="contact-error-text">{errors.message}</span>}
        </div>

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
        <button type="submit" disabled={status === 'submitting'} className="contact-button">
          {status === 'submitting' ? 'Sending...' : 'Send Message'}
        </button>
      </form>
    </div>
  )
}
