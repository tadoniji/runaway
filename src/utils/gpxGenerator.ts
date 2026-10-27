import { PositionPoint } from '../types';

/**
 * Escapes XML special characters
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '\'':
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

/**
 * Generates an authoritative standard GPX 1.1 file content from positions history
 */
export function generateGpx(gameCode: string, history: PositionPoint[]): string {
  const formattedTime = new Date().toISOString();
  const safeGameCode = escapeXml(gameCode);

  const pointsXml = history
    .map((point) => {
      const isoTime = new Date(point.timestamp).toISOString();
      const eleTag = typeof point.altitude === 'number' ? `\n        <ele>${point.altitude}</ele>` : '';
      const speedTag = typeof point.speed === 'number' ? `\n        <speed>${point.speed}</speed>` : '';
      const roleDesc = `Role: ${point.role}` + (point.mode ? ` | Mode: ${escapeXml(point.mode)}` : '');

      return `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">${eleTag}${speedTag}
        <time>${isoTime}</time>
        <desc>${roleDesc}</desc>
      </trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Runaway-Manhunt-Backend"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>Runaway Manhunt Track - Game ${safeGameCode}</name>
    <desc>Authoritative GPS track export for game ${safeGameCode}</desc>
    <time>${formattedTime}</time>
  </metadata>
  <trk>
    <name>Game Track - ${safeGameCode}</name>
    <trkseg>
${pointsXml}
    </trkseg>
  </trk>
</gpx>`;
}
