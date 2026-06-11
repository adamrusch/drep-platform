import { describe, it, expect } from 'vitest';
import { parseLegalInfo, NOT_CONFIGURED_PLACEHOLDER } from './legal';

/**
 * Unit tests for the legal info parser.
 *
 * We deliberately test the pure `parseLegalInfo` function rather than
 * `getLegalInfo` (the runtime accessor) so the tests do not depend on
 * `import.meta.env` or `process.env` state — they pass a synthetic env
 * record and assert the result. This matches the DRep Talk pattern that
 * inspired this module.
 */
describe('parseLegalInfo', () => {
  it('returns placeholders and configured=false when env is empty', () => {
    const info = parseLegalInfo({});
    expect(info.operatorName).toBe(NOT_CONFIGURED_PLACEHOLDER);
    expect(info.addressLines).toEqual([NOT_CONFIGURED_PLACEHOLDER]);
    expect(info.email).toBe(NOT_CONFIGURED_PLACEHOLDER);
    expect(info.phone).toBeNull();
    expect(info.vatId).toBeNull();
    expect(info.responsiblePerson).toBe(NOT_CONFIGURED_PLACEHOLDER);
    expect(info.configured).toBe(false);
  });

  it('parses every field and splits the address on "|"', () => {
    const info = parseLegalInfo({
      VITE_LEGAL_OPERATOR_NAME: 'Jane Doe',
      VITE_LEGAL_OPERATOR_ADDRESS: 'Some Street 1 | 12345 City | Germany',
      VITE_LEGAL_CONTACT_EMAIL: 'legal@example.com',
      VITE_LEGAL_PHONE: '+49 30 1234567',
      VITE_LEGAL_VAT_ID: 'DE123456789',
    });
    expect(info.operatorName).toBe('Jane Doe');
    expect(info.addressLines).toEqual([
      'Some Street 1',
      '12345 City',
      'Germany',
    ]);
    expect(info.email).toBe('legal@example.com');
    expect(info.phone).toBe('+49 30 1234567');
    expect(info.vatId).toBe('DE123456789');
    // Defaults to the operator name when no responsible-person override.
    expect(info.responsiblePerson).toBe('Jane Doe');
    expect(info.configured).toBe(true);
  });

  it('splits the address on newlines as well as "|"', () => {
    const info = parseLegalInfo({
      VITE_LEGAL_OPERATOR_NAME: 'Acme',
      VITE_LEGAL_OPERATOR_ADDRESS: 'Line A\nLine B\nLine C',
      VITE_LEGAL_CONTACT_EMAIL: 'a@b.c',
    });
    expect(info.addressLines).toEqual(['Line A', 'Line B', 'Line C']);
    expect(info.configured).toBe(true);
  });

  it('honours an explicit responsible person when provided', () => {
    const info = parseLegalInfo({
      VITE_LEGAL_OPERATOR_NAME: 'Acme',
      VITE_LEGAL_RESPONSIBLE_PERSON: 'Editor Name',
    });
    expect(info.responsiblePerson).toBe('Editor Name');
  });

  it('is NOT configured when one of the required fields is missing', () => {
    // Required = name + address + email. Optional = phone + vat + responsible.
    const noEmail = parseLegalInfo({
      VITE_LEGAL_OPERATOR_NAME: 'Acme',
      VITE_LEGAL_OPERATOR_ADDRESS: '1 Street',
    });
    expect(noEmail.configured).toBe(false);

    const noAddress = parseLegalInfo({
      VITE_LEGAL_OPERATOR_NAME: 'Acme',
      VITE_LEGAL_CONTACT_EMAIL: 'x@y.z',
    });
    expect(noAddress.configured).toBe(false);

    const noName = parseLegalInfo({
      VITE_LEGAL_OPERATOR_ADDRESS: '1 Street',
      VITE_LEGAL_CONTACT_EMAIL: 'x@y.z',
    });
    expect(noName.configured).toBe(false);
  });

  it('treats all-whitespace values as unset', () => {
    const info = parseLegalInfo({
      VITE_LEGAL_OPERATOR_NAME: '   ',
      VITE_LEGAL_OPERATOR_ADDRESS: '\t',
      VITE_LEGAL_CONTACT_EMAIL: '   ',
    });
    expect(info.operatorName).toBe(NOT_CONFIGURED_PLACEHOLDER);
    expect(info.configured).toBe(false);
  });
});
