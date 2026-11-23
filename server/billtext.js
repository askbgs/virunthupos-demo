// Wording for customer bills and receipts in English, Tamil and Sinhala.
// Used by the server (thermal printing) and sent to the browser in /api/config (browser printing),
// so both print the same words. Menu item names come from menu_items.name_ta / name_si when set.
const LANGS = ['en', 'ta', 'si'];

const TEXT = {
  en: {
    langName: 'English',
    bill: 'BILL', billCopy: 'BILL COPY', receiptCopy: 'RECEIPT COPY',
    table: 'Table', order: 'Order', server: 'Server', guests: 'Guests', customer: 'Customer', contact: 'Contact',
    deliverTo: 'Deliver to', tel: 'Tel', regNo: 'Reg. No',
    subtotal: 'Subtotal', discount: 'Discount', service: 'Service', tip: 'Tip', total: 'TOTAL',
    perPerson: 'Per person', paidBy: 'Paid by', card: 'Card', approval: 'Approval code',
    cashReceived: 'Cash received', change: 'Change', refund: 'Refund', spice: 'Spice',
    types: { dinein: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', counter: 'Counter' },
    methods: { cash: 'CASH', card: 'CARD', wallet: 'WALLET' },
    spiceLevels: {},
    footer: 'Thank you! Come again.',
  },
  ta: {
    langName: 'தமிழ்',
    bill: 'பில்', billCopy: 'பில் நகல்', receiptCopy: 'ரசீது நகல்',
    table: 'மேசை', order: 'ஆர்டர்', server: 'பரிமாறியவர்', guests: 'விருந்தினர்', customer: 'வாடிக்கையாளர்', contact: 'தொலைபேசி',
    deliverTo: 'விநியோக முகவரி', tel: 'தொ.பே', regNo: 'பதிவு இல',
    subtotal: 'உப மொத்தம்', discount: 'தள்ளுபடி', service: 'சேவைக் கட்டணம்', tip: 'டிப்ஸ்', total: 'மொத்தம்',
    perPerson: 'ஒருவருக்கு', paidBy: 'செலுத்திய முறை', card: 'அட்டை', approval: 'அங்கீகாரக் குறியீடு',
    cashReceived: 'பெற்ற பணம்', change: 'மீதி', refund: 'திருப்பிக் கொடுத்தது', spice: 'காரம்',
    types: { dinein: 'உணவகத்தில்', takeaway: 'எடுத்துச் செல்ல', delivery: 'டெலிவரி', counter: 'கவுண்டர்' },
    methods: { cash: 'பணம்', card: 'அட்டை', wallet: 'வாலட்' },
    spiceLevels: { Standard: 'சாதாரண', Mild: 'குறைவு', Medium: 'நடுத்தரம்', Hot: 'அதிகம்', 'Thai hot': 'மிக அதிகம்' },
    footer: 'நன்றி! மீண்டும் வருக.',
  },
  si: {
    langName: 'සිංහල',
    bill: 'බිල්පත', billCopy: 'බිල්පත් පිටපත', receiptCopy: 'රිසිට්පත් පිටපත',
    table: 'මේසය', order: 'ඇණවුම', server: 'සේවය කළේ', guests: 'අමුත්තන්', customer: 'පාරිභෝගිකයා', contact: 'දුරකථන',
    deliverTo: 'බෙදාහරින ලිපිනය', tel: 'දු.ක', regNo: 'ලි.අ',
    subtotal: 'උප එකතුව', discount: 'වට්ටම', service: 'සේවා ගාස්තුව', tip: 'ටිප්', total: 'මුළු එකතුව',
    perPerson: 'එක් අයෙකුට', paidBy: 'ගෙවූ ක්‍රමය', card: 'කාඩ්පත', approval: 'අනුමත කේතය',
    cashReceived: 'ලැබුණු මුදල', change: 'ඉතිරි මුදල', refund: 'ආපසු ගෙවීම', spice: 'සැර මට්ටම',
    types: { dinein: 'ආපනශාලාවේ', takeaway: 'රැගෙන යාමට', delivery: 'බෙදාහැරීම', counter: 'කවුන්ටරය' },
    methods: { cash: 'මුදල්', card: 'කාඩ්පත', wallet: 'වොලට්' },
    spiceLevels: { Standard: 'සාමාන්‍ය', Mild: 'අඩු', Medium: 'මධ්‍යම', Hot: 'සැරයි', 'Thai hot': 'ඉතා සැර' },
    footer: 'ස්තූතියි! නැවත එන්න.',
  },
};

const lang = (l) => (LANGS.includes(l) ? l : 'en');
const T = (l) => TEXT[lang(l)];
// Local dish name when one is set, else the English name
const itemName = (i, l) => (l === 'ta' && i.name_ta) || (l === 'si' && i.name_si) || i.name;
// Tamil and Sinhala need the bill printed as a picture: thermal printers have no fonts for them
const needsRaster = (s) => /[஀-௿඀-෿]/.test(s);

module.exports = { LANGS, TEXT, T, lang, itemName, needsRaster };
