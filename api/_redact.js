/* ==========================================================
   _redact.js — geheimen uit tekst halen vóór die de server verlaat
   ==========================================================
   Windsor zet bij een fout soms de volledige aanroep-URL in de melding,
   inclusief api_key= — en die sleutel is gedeeld over klanten. Elke foutmelding
   die naar de browser of naar een MCP-client gaat, passeert hier.
   ========================================================== */

function redact(text) {
  return String(text)
    .replace(/\b(api[_-]?key|apikey|key|token|access_token|refresh_token|client_secret|password|signature|sig)=([^&\s"'\\]+)/gi, '$1=[verwijderd]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [verwijderd]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[verwijderd]');
}

module.exports = { redact };
