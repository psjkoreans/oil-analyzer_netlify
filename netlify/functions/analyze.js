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
    // 1. HTTP 메서드 통제
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const payload = JSON.parse(event.body); 
        
        // 2. 페이로드 구조적 무결성 검증 (Defensive Programming)
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
            throw new Error("Invalid payload structure: missing required numerical fields (mileage, r, g, b).");
        }

        // 3. 시계열 궤적 분석을 위한 주행거리 오름차순 정렬
        payload.sort((a, b) => a.mileage - b.mileage);

        // 4. 의존성 없는 독자적 데이터 융합 (Jimp 제거 및 클라이언트 RGB 수용)
        const labResults = [];
        for (const item of payload) {
            const lab = rgbToLab(item.r, item.g, item.b);
            labResults.push({ mileage: item.mileage, isNew: item.isNew || false, ...lab });
        }

        let L_0 = labResults[0].L;
        let cumulativeArcLength = 0;
        let previousPoint = null;

        // 5. 다차원 오염도(Degradation Index) 및 임계점 수학적 적분
        const evaluatedData = labResults.map((row) => {
            let phase = '', colorCode = '';
            
            // 명도 기준 위상 정의
            if (row.L >= 60.0) {
                if (Math.abs(row.a) < 5.0 && Math.abs(row.b) < 15.0) { 
                    phase = 'Phase 1: 신유 (Fresh)'; colorCode = '#0000FF'; 
                } else { 
                    phase = 'Phase 1: 초기 열화 (Early Oxidation)'; colorCode = '#00FFFF'; 
                }
            } else if (row.L >= 30.0) { 
                phase = 'Phase 2: 중기 위험 (Critical Danger)'; colorCode = '#FFA500'; 
            } else { 
                phase = 'Phase 3: 칠흑색 폐유 (Terminal Sludge)'; colorCode = '#FF0000'; 
            }

            // 동적 감쇠 가중치(Decay Weighted) 텐서 연산
            const decayFunction = row.L / 100.0;
            const decayWeightedDI = 1.0 * (L_0 - row.L) + decayFunction * (Math.abs(row.a) + Math.abs(row.b));

            // 유클리드 공간 내 누적 궤적 거리 산출
            if (previousPoint) {
                cumulativeArcLength += Math.sqrt(
                    Math.pow(row.L - previousPoint.L, 2) + 
                    Math.pow(row.a - previousPoint.a, 2) + 
                    Math.pow(row.b - previousPoint.b, 2)
                );
            }
            previousPoint = { L: row.L, a: row.a, b: row.b };

            // 한계 돌파 검증 논리
            const needsReplacement = (phase === 'Phase 3: 칠흑색 폐유 (Terminal Sludge)') || (cumulativeArcLength >= 100.0);

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
                isNew: row.isNew
            };
        });

        // 6. 정상 응답 직렬화
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, data: evaluatedData })
        };

    } catch (error) {
        // 7. 명시적 클라이언트 오류 응답 (HTTP 400 Bad Request)
        return { 
            statusCode: 400, 
            body: JSON.stringify({ error: error.message }) 
        };
    }
}
