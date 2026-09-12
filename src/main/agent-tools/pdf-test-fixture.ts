/** Deterministic one-page PDF fixture using the standard Helvetica font. */
export function onePageStandardFontPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 41 >>\nstream\nBT /F1 18 Tf 72 720 Td (Wikilot) Tj ET\nendstream",
  ];
  let body = "%PDF-1.7\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  const rows = offsets.slice(1).map(
    (offset) => `${String(offset).padStart(10, "0")} 00000 n \n`,
  ).join("");
  body += `xref\n0 6\n0000000000 65535 f \n${rows}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

/** Three distinct pages, Info fields, nested/named/broken/external bookmarks. */
export function readingPdf(withXmp = false): Buffer {
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const page = (content: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents ${content} 0 R >>`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R /Dests << /chapter [5 0 R /Fit] >> ${withXmp ? "/Metadata 16 0 R" : ""} >>`,
    "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>",
    page(7), page(8), page(9),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 18 Tf 72 720 Td (First page) Tj 0 -24 Td (Second line) Tj ET"),
    stream(""),
    stream("BT /F1 18 Tf 72 720 Td (Third page) Tj ET"),
    "<< /Type /Outlines /First 11 0 R /Last 14 0 R /Count 4 >>",
    "<< /Title (Start) /Parent 10 0 R /Dest [3 0 R /Fit] /Next 13 0 R /First 12 0 R /Last 12 0 R /Count 1 >>",
    "<< /Title (Chapter) /Parent 11 0 R /Dest (chapter) >>",
    "<< /Title (Broken) /Parent 10 0 R /Prev 11 0 R /Next 14 0 R /Dest (missing) >>",
    "<< /Title (External) /Parent 10 0 R /Prev 13 0 R /A << /S /URI /URI (https://example.com/) >> >>",
    "<< /Title (Reading fixture) /Creator (Wikilot tests) >>",
  ];
  if (withXmp) {
    const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><dc:title>XMP title</dc:title><dc:creator><rdf:Seq><rdf:li>Alice</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator><xmp:CreateDate>2026-09-11T00:00:00Z</xmp:CreateDate><xmp:ModifyDate>2026-09-12T00:00:00Z</xmp:ModifyDate><xmp:CreatorTool>XMP creator</xmp:CreatorTool><pdf:Producer>XMP producer</pdf:Producer></rdf:Description></rdf:RDF></x:xmpmeta>';
    objects.push(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xml)} >>\nstream\n${xml}\nendstream`);
  }
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 15 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
