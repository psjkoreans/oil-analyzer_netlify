const Jimp = require('jimp');

function rgbToOpenCVLab(R, G, B) {
    let r = R / 255.0, g = G / 255.0, b = B / 255.0;

    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    r *= 100; g *= 100; b *= 100;

    let x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    x /= 95.047; y /= 100.000; z /= 108.883;

    x = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + (16 / 116);
    y = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + (16 / 116);
    z = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + (16 / 116);

    let L = (116 * y) - 16;
    let a = 500 * (x - y);
    let b_val = 200 * (y - z);

    let cv_L = L * 2.55;
    let cv_a = a + 128;
    let cv_b = b_val + 128;

    return [cv_L, cv_a, cv_b];
}

exports.handler = async function(event, context) {
    try {
        if (event.httpMethod !== 'POST') {
            return {
                statusCode: 405,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Method Not Allowed" })
            };
        }

        const bodyStr = event.body || '{}';
        if (!bodyStr) {
            return { statusCode: 400, body: JSON.stringify({ error: "데이터 누락" }) };
        }
        
        const content = JSON.parse(bodyStr);
        const imgStr = content.image;

        if (!imgStr) {
            return { statusCode: 400, body: JSON.stringify({ error: "이미지 데이터 없음" }) };
        }

        const imgBuffer = Buffer.from(imgStr, 'base64');
        const image = await Jimp.read(imgBuffer);

        const w = image.bitmap.width;
        const h = image.bitmap.height;
        const centerX = Math.floor(w / 2);
        const centerY = Math.floor(h / 2);
        const radius = Math.floor(Math.min(w, h) / 3);
        const radiusSq = radius * radius;

        let sumR = 0, sumG = 0, sumB = 0, count = 0;

        image.scan(0, 0, w, h, function(x, y, idx) {
            const dx = x - centerX;
            const dy = y - centerY;
            if ((dx * dx + dy * dy) <= radiusSq) {
                sumR += this.bitmap.data[idx + 0];
                sumG += this.bitmap.data[idx + 1];
                sumB += this.bitmap.data[idx + 2];
                count++;
            }
        });

        if (count === 0) {
            throw new Error("마스킹 영역(ROI) 내에 유효한 픽셀이 존재하지 않습니다.");
        }

        const avgR = sumR / count;
        const avgG = sumG / count;
        const avgB = sumB / count;

        const [l, a, b] = rgbToOpenCVLab(avgR, avgG, avgB);

        const ref_l = 60.0, ref_a = 142.0, ref_b = 155.0; 
        const delta_e = Math.sqrt(Math.pow(l - ref_l, 2) + Math.pow(a - ref_a, 2) + Math.pow(b - ref_b, 2));

        let phase = "Phase 1: 신유";
        if (delta_e >= 45.0) phase = "Phase 3: 폐유";
        else if (delta_e >= 20.0) phase = "Phase 2: 주의";
        
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                Delta_E: parseFloat(delta_e.toFixed(2)),
                Phase: phase,
                Needs_Replacement: delta_e >= 45.0
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: err.message })
        };
    }
};
