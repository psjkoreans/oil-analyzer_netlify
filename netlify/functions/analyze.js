// netlify/functions/analyze.js

/**
 * sRGB 색공간을 CIE L*a*b* 색공간으로 변환하는 수리적 함수
 * D65 표준 광원을 기준으로 비선형 보정(Gamma Correction) 수행
 */
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

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const payload = JSON.parse(event.body); 
        
        // 페이로드 구조적 무결성 검증
        if (!Array.isArray(payload) || payload.length === 0) {
            throw new Error("Payload must be a non-empty array of objects.");
        }

        const isValid = payload.every(item => 
            typeof item.mileage === 'number' &&
            typeof item.r === 'number' &&
            typeof item.g === 'number' &&
            typeof item.b === 'number'
        );

        if (!isValid) {
            throw new Error("Invalid payload structure: missing required numerical fields.");
        }

        // 시계열 궤적 분석을 위한 주행거리 오름차순 정렬
        payload.sort((a, b) => a.mileage - b.mileage);

        // L*a*b* 공간 변환
        const labResults = payload.map(item => ({
            mileage: item.mileage,
            isNew: item.isNew || false,
            ...rgbToLab(item.r, item.g, item.b)
        }));

        // 기준점(Reference) 설정: 배열의 첫 번째 값(가장 낮은 주행거리)을 신유 상태로 간주
        const ref_L = labResults[0].L;
        const ref_a = labResults[0].a;
        const ref_b = labResults[0].b;

        let isSaturated = false;
        let saturatedRawDI = null;

        // Pass 1: 유클리디안 색차(Delta E) 산출 및 포화 임계점 기반 절사(Clipping)
        const rawData = labResults.map((row) => {
            let currentPhase = '';
            let rawDeltaE = Math.sqrt(
                Math.pow(row.L - ref_L, 2) + 
                Math.pow(row.a - ref_a, 2) + 
                Math.pow(row.b - ref_b, 2)
            );

            // 포화 임계점 검증 (L* < 30.0)
            if (isSaturated || row.L < 30.0) {
                isSaturated = true;
                currentPhase = 'Phase 4: 교체 요망 (Replacement Required - Saturated)';
                
                // 데이터 절사: 포화 이후의 노이즈성 Delta E 변동을 무시하고 값을 동결
                if (saturatedRawDI === null) {
                    saturatedRawDI = rawDeltaE; 
                }
                rawDeltaE = saturatedRawDI; 
            } else if (rawDeltaE < 15.0) {
                currentPhase = 'Phase 1: 신유 및 초기 (Normal)';
            } else {
                currentPhase = 'Phase 2/3: 열화 진행 중 (Degradation in Progress)';
            }

            return { ...row, rawDI: rawDeltaE, phase: currentPhase };
        });

        // Pass 2: 시계열 데이터 평활화 (Exponential Moving Average)
        const smoothingFactor = 0.5; // 알파(alpha) 값: 낮을수록 과거 데이터에 의존(평활도 증가)
        let smoothedDI = rawData[0].rawDI;

        const evaluatedData = rawData.map((row, index) => {
            if (index === 0) {
                smoothedDI = row.rawDI;
            } else {
                // EMA 수식: S_t = \alpha * Y_t + (1 - \alpha) * S_{t-1}
                smoothedDI = (smoothingFactor * row.rawDI) + ((1 - smoothingFactor) * smoothedDI);
            }

            // Delta E 45.0을 물리적 한계점(Tolerance Limit)으로 설정
            const needsReplacement = row.phase.includes('Phase 4') || smoothedDI >= 45.0;

            let colorCode = '#0000FF'; // Phase 1
            if (needsReplacement) {
                colorCode = '#8B0000'; // Dark Red for Phase 4 / Replacement
            } else if (row.phase.includes('Phase 2/3')) {
                colorCode = '#FFA500'; // Orange for Phase 2/3
            }

            return {
                x: row.mileage,
                y: parseFloat(smoothedDI.toFixed(2)), // 노이즈가 제거된 최종 종합 오염도(DI)
                L: row.L,
                a: row.a,
                b: row.b,
                phase: row.phase,
                needsReplacement: needsReplacement,
                pointColor: colorCode,
                isNew: row.isNew
            };
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, data: evaluatedData })
        };

    } catch (error) {
        return { 
            statusCode: 400, 
            body: JSON.stringify({ error: error.message }) 
        };
    }
}
