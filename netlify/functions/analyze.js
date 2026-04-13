const Jimp = require('jimp');

/**
 * 표준 CIE L*a*b* 및 OpenCV 스타일 Lab 변환 함수
 * @param {number} R, G, B (0-255)
 * @returns {Object} {cie: [L, a, b], opencv: [L, a, b]}
 */
function getLabCoordinates(R, G, B) {
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

    const L_cie = (116 * y) - 16;
    const a_cie = 500 * (x - y);
    const b_cie = 200 * (y - z);

    return {
        cie: [L_cie, a_cie, b_cie],
        opencv: [L_cie * 2.55, a_cie + 128, b_cie + 128]
    };
}

// 비교를 위한 기존 저장 데이터 (Reference Dataset)
// 실제 운영 시에는 DB나 JSON 파일에서 로드하도록 확장 가능
const HISTORICAL_DATA = [
    { mileage: 0, l: 75.2, a: -1.2, b: 12.5, phase: "Phase 1: 신유" },
    { mileage: 3000, l: 62.5, a: 5.4, b: 28.1, phase: "Phase 1: 초기 열화" },
    { mileage: 7000, l: 45.1, a: 12.3, b: 35.4, phase: "Phase 2: 주의" },
    { mileage: 12000, l: 22.8, a: 8.1, b: 15.2, phase: "Phase 3: 폐유" },
    { mileage: 15000, l: 12.4, a: 3.2, b: 5.1, phase: "Phase 3: 폐유" }
];

exports.handler = async function(event, context) {
    try {
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
        }

        const { image: imgStr } = JSON.parse(event.body || '{}');
        if (!imgStr) return { statusCode: 400, body: JSON.stringify({ error: "이미지 데이터 없음" }) };

        const image = await Jimp.read(Buffer.from(imgStr, 'base64'));
        const { width: w, height: h } = image.bitmap;
        const centerX = w / 2, centerY = h / 2;
        const radiusSq = Math.pow(Math.min(w, h) / 3, 2);

        let sumR = 0, sumG = 0, sumB = 0, count = 0;

        image.scan(0, 0, w, h, function(x, y, idx) {
            if (Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2) <= radiusSq) {
                sumR += this.bitmap.data[idx + 0];
                sumG += this.bitmap.data[idx + 1];
                sumB += this.bitmap.data[idx + 2];
                count++;
            }
        });

        if (count === 0) throw new Error("ROI 내 유효 픽셀 없음");

        // 1. 현재 샘플 특성 추출
        const labs = getLabCoordinates(sumR / count, sumG / count, sumB / count);
        const [curL, curA, curB] = labs.cie;
        
        // 2. 아키텍처 기반 계산 (열화 지수 및 거리)
        const L_0 = HISTORICAL_DATA[0].l; // 신유 기준점
        const decayDI = (1.0 * (L_0 - curL)) + (curL / 100.0) * (Math.abs(curA) + Math.abs(curB));
        const trajectoryDist = Math.sqrt(Math.pow(curL - L_0, 2) + Math.pow(curA - HISTORICAL_DATA[0].a, 2) + Math.pow(curB - HISTORICAL_DATA[0].b, 2));

        // 3. Phase 판정 로직 (Ensemble)
        let phase = "Phase 1: 신유";
        if (curL < 30.0 || trajectoryDist > 80.0) phase = "Phase 3: 폐유";
        else if (curL < 55.0 || trajectoryDist > 40.0) phase = "Phase 2: 주의";

        // 4. 시각화용 통합 데이터 구성
        const responseData = {
            current_sample: {
                l: parseFloat(curL.toFixed(2)),
                a: parseFloat(curA.toFixed(2)),
                b: parseFloat(curB.toFixed(2)),
                di: parseFloat(decayDI.toFixed(2)),
                distance: parseFloat(trajectoryDist.toFixed(2)),
                phase: phase,
                needs_replacement: curL < 30.0 || trajectoryDist > 80.0
            },
            historical_dataset: HISTORICAL_DATA, // 웹에서 그래프를 그리기 위한 데이터
            metadata: {
                timestamp: new Date().toISOString(),
                status: "success"
            }
        };

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify(responseData)
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
