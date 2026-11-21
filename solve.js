// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly what
// csv-reader 1.0.0 returns for {text, header} — {columns, rows, errors} —
// but reads the text with indexOf/charCodeAt scans and slice() instead of
// one character at a time with per-character concatenation.
//
// Reading policy (csv-reader's own, reimplemented here):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled
//     ("" inside it is one quote, each CRLF or lone CR inside it is read as
//     LF); what follows its closing quote, up to the next comma or line break,
//     is appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row, with fields: its count) or
//     cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside quotes
//     counted), row its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free ES module.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of a record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at pos, with initial value `value`
  // ('' normally, '"' when re-reading after an unterminated quote, a quoted
  // field's value when reading what follows its closing quote). Returns
  // [value, ended, added], where added counts the characters kept. A CR not
  // followed by LF is dropped (stray_cr) and reading goes on.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      let i = pos;
      while (i < n) {
        const cc = text.charCodeAt(i);
        if (cc === 44 || cc === 10 || cc === 13) break;
        i++;
      }
      if (i >= n) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = n;
        return [value, END, added];
      }
      const cc = text.charCodeAt(i);
      if (cc === 44) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        return [value, COMMA, added];
      }
      if (cc === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      if (text.charCodeAt(i + 1) === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 2;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      // A lone CR: dropped, and the field goes on past it.
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns
  // [value, ended, added] (added is 0 here; only readUnquoted's junk counts).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = open + 1;
    let value = null; // null: no doubled quote or line break met yet; the
    // value is then just the slice between the quotes.
    let seg = i; // start of the current untouched segment
    let closed = false;
    while (i < n) {
      const cc = text.charCodeAt(i);
      if (cc === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          // A doubled quote is one literal quote in the value.
          if (value === null) value = text.slice(seg, i);
          else value += text.slice(seg, i);
          value += '"';
          i += 2;
          seg = i;
        } else {
          closed = true;
          break;
        }
      } else if (cc === 10) {
        if (value === null) value = text.slice(seg, i);
        else value += text.slice(seg, i);
        value += '\n';
        line += 1;
        i += 1;
        seg = i;
      } else if (cc === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (value === null) value = text.slice(seg, i);
        else value += text.slice(seg, i);
        value += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
      } else {
        i += 1;
      }
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (value === null) value = text.slice(open + 1, i);
    else value += text.slice(seg, i);
    pos = i + 1;
    if (pos >= n) return [value, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Reads one record's fields starting at pos. Returns the fields, or null
  // when the line held only stray CRs and so is no record. Updates pos and
  // line; pushes the record's field errors in the order met.
  function parseRecord() {
    const fields = [];
    let quoted = false;
    let ended = COMMA;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const field = readQuoted();
        fields.push(field[0]);
        ended = field[1];
      } else {
        quoted = false;
        // The common unquoted field, inlined: scan to the next delimiter and
        // take the field as one slice. A stray CR hands the rest of the
        // field to readUnquoted.
        let i = pos;
        while (i < n) {
          const cc = text.charCodeAt(i);
          if (cc === 44 || cc === 10 || cc === 13) break;
          i++;
        }
        if (i >= n) {
          fields.push(text.slice(pos, i));
          pos = n;
          ended = END;
        } else {
          const cc = text.charCodeAt(i);
          if (cc === 44) {
            fields.push(text.slice(pos, i));
            pos = i + 1;
            ended = COMMA;
          } else if (cc === 10) {
            fields.push(text.slice(pos, i));
            pos = i + 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (text.charCodeAt(i + 1) === 10) {
            fields.push(text.slice(pos, i));
            pos = i + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            const first = text.slice(pos, i);
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            pos = i + 1;
            const field = readUnquoted(first);
            fields.push(field[0]);
            ended = field[1];
          }
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return null;
    return fields;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const cc = text.charCodeAt(pos);
      if (cc === 10) {
        pos += 1;
        line += 1;
      } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the whole record sits on one line with no quote and no
    // stray CR in it, so its fields are one split. A quote or a CR anywhere
    // before the line break falls through to the field-by-field reader.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const q = text.indexOf('"', pos);
    let fields = null;
    if (q === -1 || q >= segEnd) {
      const r = text.indexOf('\r', pos);
      if (r === -1 || r >= segEnd || (nl !== -1 && r === segEnd - 1)) {
        const end = nl !== -1 && r === segEnd - 1 ? segEnd - 1 : segEnd;
        fields = text.slice(pos, end).split(',');
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
      }
    }
    if (fields === null) {
      fields = parseRecord();
      if (fields === null) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
