import { describe, expect, it } from 'vitest'

import { apiBaseUrl } from './api'

describe('api base url', () => {
  it('defaults to localhost', () => {
    expect(apiBaseUrl).toContain('http://localhost:8000')
  })
})

