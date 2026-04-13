const Jimp = require('jimp');

function rgbToLab(r, g, b) {
    let r_l = r / 255.0, g_l = g / 255.0, b_l = b / 255.0;
    r_l = (r_l > 0.04045) ? Math.pow((r_l + 0.055) / 1.055, 2.4) : r_l / 12.92;
    g_l = (g_l > 0.04045) ? Math.pow((g_l + 0.055) / 1.055, 2.4) : g_l / 12.92;
    b_l = (b_l > 0.04045) ? Math.pow((b_l + 0.055) / 1.055, 2.4) : b_l / 12.92;

    let x = (r_l * 0.4124 + g_l * 0.3576 + b_l * 0.1805) * 100;
    let y = (r_l * 0.2126 + g_l * 0.7152 + b_l * 0.0722) * 100;
    let z = (r_l * 0.0193 + g_l * 0.1192 + b_l * 0.9505) * 100;

    x /= 95.047; y /= 100.000; z /= 108.883;

    x = (x > 0.008856) ? Math.pow(x, 1/3) : (7.787 * x) + (16 / 116);
    y = (y > 0.008856) ? Math.pow(y, 1/3) : (7.787 * y) + (16 / 116);
    z = (z > 0.008856) ? Math.pow(z, 1/3) : (7.787 * z) + (16 / 116);

    return { L: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

async function extractLabFromBase64(base64Str) {
    const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const image = await Jimp.read(buffer);
    
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    const startX = Math.floor(w * 0.25), startY = Math.floor(h * 0.25);
    const roiW = Math.floor(w * 0.5), roiH = Math.floor(h * 0.5);

    let totalR = 0, totalG = 0, totalB = 0, count = 0;

    image.scan(startX, startY, roiW, roiH, function (x, y, idx) {
        totalR += this.bitmap.data[idx + 0];
        totalG += this.bitmap.data[idx + 1];
        totalB += this.bitmap.data[idx + 2];
        count++;
    });

    return rgbToLab(totalR / count, totalG / count, totalB / count);
}

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const payload = JSON.parse(event.body); 
        
        if (!Array.isArray(payload) || payload.length === 0) {
            throw new Error("Payload must be a non-empty array of objects with mileage and imageBase64.");
        }

        payload.sort((a, b) => a.mileage - b.mileage);

        // 프론트엔드의 isNew 플래그를 유지하며 처리
        const labResults = [];
        for (const item of payload) {
            const lab = await extractLabFromBase64(item.imageBase64);
            labResults.push({ mileage: item.mileage, isNew: item.isNew, ...lab });
        }

        let L_0 = labResults[0].L;
        let cumulativeArcLength = 0;
        let previousPoint = null;

        const evaluatedData = labResults.map((row) => {
            let phase = '', colorCode = '';
            
            if (row.L >= 60.0) {
                if (Math.abs(row.a) < 5.0 && Math.abs(row.b) < 15.0) { phase = 'Phase 1: 신유 (Fresh)'; colorCode = '#0000FF'; }
                else { phase = 'Phase 1: 초기 열화 (Early Oxidation)'; colorCode = '#00FFFF'; }
            } else if (row.L >= 30.0) { phase = 'Phase 2: 중기 위험 (Critical Danger)'; colorCode = '#FFA500'; }
            else { phase = 'Phase 3: 칠흑색 폐유 (Terminal Sludge)'; colorCode = '#FF0000'; }

            const decayFunction = row.L / 100.0;
            const decayWeightedDI = 1.0 * (L_0 - row.L) + decayFunction * (Math.abs(row.a) + Math.abs(row.b));

            if (previousPoint) {
                cumulativeArcLength += Math.sqrt(
                    Math.pow(row.L - previousPoint.L, 2) + Math.pow(row.a - previousPoint.a, 2) + Math.pow(row.b - previousPoint.b, 2)
                );
            }
            previousPoint = { L: row.L, a: row.a, b: row.b };

            const needsReplacement = (phase === 'Phase 3: 칠흑색 폐유 (Terminal Sludge)') || (cumulativeArcLength >= 100.0);

            // 클라이언트 사이드 시각화를 위한 변수 일체 반환
            return {
                x: row.mileage,
                y: decayWeightedDI,
                L: row.L,
                a: row.a,
                b: row.b,
                phase: phase,
                arcLength: cumulativeArcLength,
                needsReplacement: needsReplacement,
                pointColor: needsReplacement ? '#8B0000' : colorCode,
                isNew: row.isNew || false
            };
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, data: evaluatedData })
        };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
}
