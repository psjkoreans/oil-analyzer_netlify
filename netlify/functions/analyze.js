const Jimp = require('jimp');

// [모듈 1] sRGB to CIE L*a*b* 수학적 변환
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

    const L = (116 * y) - 16;
    const a = 500 * (x - y);
    const b = 200 * (y - z);
    return { L, a, b };
}

// [모듈 2] 이미지 기반 평균 LAB 추출 (Otsu 분리 생략, 중심부 관심영역(ROI) 기반 경량화 처리)
async function extractLabFromBase64(base64Str) {
    // base64 헤더 제거 처리
    const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const image = await Jimp.read(buffer);
    
    // 중앙 50% 영역의 평균 색상 추출 (서버리스 최적화)
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    const startX = Math.floor(w * 0.25), startY = Math.floor(h * 0.25);
    const roiW = Math.floor(w * 0.5), roiH = Math.floor(h * 0.5);

    let totalR = 0, totalG = 0, totalB = 0;
    let count = 0;

    image.scan(startX, startY, roiW, roiH, function (x, y, idx) {
        totalR += this.bitmap.data[idx + 0];
        totalG += this.bitmap.data[idx + 1];
        totalB += this.bitmap.data[idx + 2];
        count++;
    });

    return rgbToLab(totalR / count, totalG / count, totalB / count);
}

// [모듈 3] Netlify Serverless Handler
exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const payload = JSON.parse(event.body); 
        // Expected payload: [ { mileage: 0, imageBase64: "..." }, { mileage: 5000, imageBase64: "..." } ]
        
        if (!Array.isArray(payload) || payload.length === 0) {
            throw new Error("Payload must be a non-empty array of objects with mileage and imageBase64.");
        }

        // 마일리지 기준 정렬
        payload.sort((a, b) => a.mileage - b.mileage);

        // 비동기 이미지 처리
        const labResults = await Promise.all(payload.map(async (item) => {
            const lab = await extractLabFromBase64(item.imageBase64);
            return { mileage: item.mileage, ...lab };
        }));

        let L_0 = labResults[0].L;
        let cumulativeArcLength = 0;
        let previousPoint = null;

        const evaluatedData = labResults.map((row, index) => {
            // 아키텍처 1: 조건부 위상 게이팅
            let phase = '';
            let colorCode = '';
            if (row.L >= 60.0) {
                if (Math.abs(row.a) < 5.0 && Math.abs(row.b) < 15.0) {
                    phase = 'Phase 1: 신유 (Fresh)'; colorCode = '#0000FF'; // Blue
                } else {
                    phase = 'Phase 1: 초기 열화 (Early Oxidation)'; colorCode = '#00FFFF'; // Cyan
                }
            } else if (row.L >= 30.0) {
                phase = 'Phase 2: 중기 위험 (Critical Danger)'; colorCode = '#FFA500'; // Orange
            } else {
                phase = 'Phase 3: 칠흑색 폐유 (Terminal Sludge)'; colorCode = '#FF0000'; // Red
            }

            // 아키텍처 2: 가중치 감쇠 다항식 (오염도 지표로 활용)
            const decayFunction = row.L / 100.0;
            const decayWeightedDI = 1.0 * (L_0 - row.L) + decayFunction * (Math.abs(row.a) + Math.abs(row.b));

            // 아키텍처 3: 기준 궤적 투영법
            if (previousPoint) {
                const dist = Math.sqrt(
                    Math.pow(row.L - previousPoint.L, 2) +
                    Math.pow(row.a - previousPoint.a, 2) +
                    Math.pow(row.b - previousPoint.b, 2)
                );
                cumulativeArcLength += dist;
            }
            previousPoint = { L: row.L, a: row.a, b: row.b };

            // 앙상블 판정 로직
            const condA = phase === 'Phase 3: 칠흑색 폐유 (Terminal Sludge)';
            const condB = cumulativeArcLength >= 100.0;
            const needsReplacement = condA || condB;

            // 교체 필요 시 시각적 강조를 위한 특수 마커 색상 배정
            const finalColor = needsReplacement ? '#8B0000' : colorCode; // Dark Red for replacement

            return {
                x: row.mileage,                     // x축: 마일리지
                y: decayWeightedDI,                 // y축: 오염도 (Calculated DI)
                L_CIE: row.L,
                phase: phase,
                arcLength: cumulativeArcLength,
                needsReplacement: needsReplacement, // 프론트엔드에서 이중 원(Highlight)을 그리기 위한 Boolean
                pointColor: finalColor              // 각 데이터의 색상
            };
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                success: true, 
                data: evaluatedData 
            })
        };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
}
