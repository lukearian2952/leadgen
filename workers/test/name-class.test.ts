import { describe, it, expect } from 'vitest'
import {
  classifyTitle, classifyPerson, classifyPersonName,
  hasOwnershipVoice, solePersonOwnership, promotesToOwner,
} from '../src/lib/name-class.js'

describe('classifyTitle — owner grade', () => {
  // Every one of these was accepted by the Phase 2 run and must stay accepted.
  it.each([
    'Medical Director', 'CEO & FOUNDER', 'Owner', 'Chief Executive Officer',
    'Co-Founder', 'Founder', 'Managing Partner',
  ])('keeps %s owner-grade', title => {
    expect(classifyTitle(title)).toBe('owner_grade')
  })

  it('treats owner-plus-clinical as owner, not clinical', () => {
    expect(classifyTitle('Owner & Nurse Practitioner')).toBe('owner_grade')
    expect(classifyTitle('Founder / Esthetician')).toBe('owner_grade')
  })
})

describe('classifyTitle — clinical lead', () => {
  // The 21 leads the Phase 2 title gate rejected. These are the whole point.
  it.each([
    'board-certified Nurse Practitioner',
    'CRNA',
    'Physician Assistant',
    'MD',
    'Dr. ',
    'Nurse Injector',
    'Registered Nurse',
    'DDS',
    'L.Ac.',
  ])('classifies %s as clinical_lead', title => {
    expect(classifyTitle(title)).toBe('clinical_lead')
  })

  it('does not promote clinical titles on their own', () => {
    expect(promotesToOwner([])).toBe(false)
  })
})

describe('classifyTitle — staff', () => {
  it.each([
    'Esthetician', 'Massage Therapist', 'LMT', 'hairdresser',
    'Pilates Instructor', 'General Staff', '', 'Receptionist',
  ])('classifies %s as staff', title => {
    expect(classifyTitle(title)).toBe('staff')
  })

  it('does not read "Spa Manager" as a physician assistant', () => {
    // The letter-credential patterns are case-sensitive precisely for this:
    // /pa/i matches inside "Spa", and PA is also Pennsylvania and "P.A.".
    expect(classifyTitle('Spa Manager')).toBe('staff')
    expect(classifyTitle('Spa Attendant')).toBe('staff')
  })

  it('does not read "Pennsylvania" as a credential', () => {
    expect(classifyTitle('Regional Lead, Pennsylvania')).toBe('staff')
  })
})

describe('classifyPersonName', () => {
  it('reads a credential off the name when the title is blank', () => {
    // Seven of the 21 Phase 2 rejections had no title at all.
    expect(classifyPerson('Joseph Pham, NP', '')).toBe('clinical_lead')
    expect(classifyPerson('Adriana Natividade, PA', '')).toBe('clinical_lead')
    expect(classifyPerson('Dr. Jane Smith', '')).toBe('clinical_lead')
  })

  it('does not fire on a name that merely starts with those letters', () => {
    expect(classifyPersonName('Drew Palmer')).toBeNull()
    expect(classifyPersonName('Napoleon Reyes')).toBeNull()
    expect(classifyPersonName('Paula Mendes')).toBeNull()
  })

  it('lets an owner title beat a clinical name', () => {
    expect(classifyPerson('Dr. Jane Smith', 'Founder')).toBe('owner_grade')
  })
})

describe('ownership voice', () => {
  it('accepts first-person ownership claims', () => {
    expect(hasOwnershipVoice('I opened this practice in 2015 after ten years.')).toBe(true)
    expect(hasOwnershipVoice('My clinic has served Nassau County since 2009.')).toBe(true)
    expect(hasOwnershipVoice("I'm the owner and lead injector.")).toBe(true)
  })

  it('rejects ordinary marketing copy', () => {
    expect(hasOwnershipVoice('We are a team of experts dedicated to you.')).toBe(false)
    expect(hasOwnershipVoice('Our staff will make you feel at home.')).toBe(false)
    expect(hasOwnershipVoice('Book your appointment today.')).toBe(false)
  })
})

describe('solePersonOwnership', () => {
  it('requires exactly one person AND the voice', () => {
    expect(solePersonOwnership(1, 'I founded this spa.')).toBe(true)
    expect(solePersonOwnership(1, 'We offer many services.')).toBe(false)
    // Six providers plus "I founded this practice" identifies nobody.
    expect(solePersonOwnership(6, 'I founded this practice.')).toBe(false)
    expect(solePersonOwnership(0, 'I founded this practice.')).toBe(false)
  })
})
