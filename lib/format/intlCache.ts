/**
 * Shared `Intl.DateTimeFormat` and `Intl.NumberFormat` instances.
 *
 * Building a formatter is expensive: each one loads ICU calendar, timezone
 * and currency data into native (non-JS-heap) memory, and Node returns little
 * of it to the operating system. Formatting in a loop with a fresh formatter
 * per value (for example once per registration or order on a large event's
 * dashboard) allocated gigabytes of native memory per request. Formatters are
 * immutable and safe to reuse, so every hot path asks this cache instead of
 * calling the constructor.
 *
 * The key is the locale plus the options object as written, so call sites
 * should pass options in a consistent order. The caches are bounded: the
 * inputs are a handful of locales and option shapes times the IANA zones and
 * currencies events use.
 */

const MAX_ENTRIES = 512;

function cached<T>(store: Map<string, T>, locale: string | undefined, options: object, create: () => T): T {
  const key = `${locale ?? ""}\u0000${JSON.stringify(options)}`;
  const hit = store.get(key);
  if (hit) return hit;
  // Throws a RangeError for an unknown time zone or currency, like the
  // constructor; a failed construction is never cached.
  const formatter = create();
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, formatter);
  return formatter;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

export function cachedDateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(dateFormatters, locale, options, () => new Intl.DateTimeFormat(locale, options));
}

export function cachedNumberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached(numberFormatters, locale, options, () => new Intl.NumberFormat(locale, options));
}

/** Number of cached date formatters; for tests. */
export function cachedDateTimeFormatCount(): number {
  return dateFormatters.size;
}
