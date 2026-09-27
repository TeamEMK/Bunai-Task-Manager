// ══════════════════════════════════════════════════════
// WHO THE COMPANY IS, AND WHERE
//
// One file, because several things say it: the interview and reschedule
// letters print a "Where to come" block, the offer letter names the company in
// its own sentences, and the letterhead at the head of that PDF carries the
// address in an image. Kept together so a change never corrects one of them
// and misses the others.
//
// Taken from the letterhead the office sent through — that is the version a
// candidate will be holding, so it is the one that wins.
// ══════════════════════════════════════════════════════

const COMPANY = 'Bunai Private Limited';

/**
 * Where an interview is held.
 *
 *   address: one line per line, as the letterhead words it
 *   map:     a Google Maps share link, or blank for no map button
 *
 * No floor number: the office has one, but nobody has said which — and an
 * invitation that sends somebody to the wrong floor is worse than one that
 * sends them to the gate. Put it in the note box on the interview, which is
 * written for that candidate and goes in the same letter.
 */
const OFFICE = {
  address: 'Bunai Private Limited\nG1-592, Sitapura Industrial Area\nJaipur, India, 302022',
  map: '',
  phone: '+91-876-444-1111',
  email: 'info@bunai.com',
};

/** The address as plain lines, blank ones dropped. */
function officeLines() {
  return String(OFFICE.address || '').split('\n').map(l => l.trim()).filter(Boolean);
}

module.exports = { COMPANY, OFFICE, officeLines };
