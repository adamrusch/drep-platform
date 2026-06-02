import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import ja from './locales/ja.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'ja', label: '日本語', short: 'JP' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/**
 * i18n bootstrap. English is the source-of-truth fallback; Japanese is the
 * first added locale. Language is detected from (and persisted to) localStorage,
 * then the browser's `navigator.language`. Missing keys fall through to English,
 * so a partially-translated locale degrades gracefully rather than showing raw
 * keys — that's deliberate while translation coverage is still expanding.
 */
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'ja'],
    nonExplicitSupportedLngs: true, // ja-JP → ja
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'drep_lang',
      caches: ['localStorage'],
    },
    returnEmptyString: false,
  });

export default i18n;
