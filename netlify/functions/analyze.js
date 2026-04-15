// netlify/functions/analyze.js

/**
 * sRGB -> CIE L*a*b* 변환 함수 (D65 광원 기준)
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

/**
 * 멱법(Power Iteration)을 이용한 제1주성분(PC1) 추출
 * 데이터의 공분산 행렬에서 가장 지배적인 고유벡터를 계산합니다.
 */
function getPC1Vector(matrix) {
    const n = matrix.length;
    const dims = 3; // L, a, b
    
    // 1. 중심화 (Mean Centering)
    let mean = [0, 0, 0];
    matrix.forEach(row => { row.forEach((v, i) => mean[i] += v / n); });
    let centered = matrix.map(row => row.map((v, i) => v - mean[i]));

    // 2. 공분산 행렬 계산
    let cov = Array(dims).fill(0).map(() => Array(dims).fill(0));
    for (let i = 0; i < dims; i++) {
        for (let j = 0; j < dims; j++) {
            for (let k = 0; k < n; k++) {
                cov[i][j] += (centered[k][i] * centered[k][j]) / (n - 1);
            }
        }
    }

    // 3. 멱법으로 고유벡터 추출
    let v = [1, 1, 1]; // 초기 추측값
    for (let iter = 0; iter < 15; iter++) {
        let nextV = [0, 0, 0];
        for (let i = 0; i < dims; i++) {
            for (let j = 0; j < dims; j++) {
                nextV[i] += cov[i][j] * v[j];
            }
        }
        let norm = Math.sqrt(nextV.reduce((sum, val) => sum + val * val, 0));
        v = nextV.map(val => val / norm);
    }

    // 물리적 제약: 오일 열화는 명도(L*)의 감소를 동반해야 함. 
    // 만약 L* 성분이 양수라면 벡터의 방향을 반전시킴.
    if (v[0] > 0) v = v.map(val => -val);
    
    return v;
}

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const payload = JSON.parse(event.body);
        payload.sort((a, b) => a.mileage - b.mileage);

        // Lab 변환 및 데이터 준비
        const labResults = payload.map(item => ({
            mileage: item.mileage,
            isNew: item.isNew || false,
            ...rgbToLab(item.r, item.g, item.b)
        }));

        // 대칭적 파이프라인: 모든 데이터(신유 포함)에 대해 PCA 벡터 산출
        const dataMatrix = labResults.map(d => [d.L, d.a, d.b]);
        const pc1 = getPC1Vector(dataMatrix);

        // 기준점(Reference) 설정
        const ref = labResults[0];

        const evaluatedData = labResults.map((row) => {
            // 방향성 오염도 계산: (현재 샘플 - 기준점) 벡터를 PC1에 투영
            const diffVector = [row.L - ref.L, row.a - ref.a, row.b - ref.b];
            let directionalDI = diffVector[0] * pc1[0] + diffVector[1] * pc1[1] + diffVector[2] * pc1[2];
            
            // 물리적 비가역성: 오염도는 감소할 수 없음 (역방향 투영 차단)
            directionalDI = Math.max(0, directionalDI);

            let phase = '';
            const isSaturated = row.L < 30.0;
            
            if (isSaturated || directionalDI > 45.0) {
                phase = 'Phase 4: 교체 요망 (Limit Reached)';
            } else if (directionalDI < 12.0) {
                phase = 'Phase 1: 양호 (Stable)';
            } else {
                phase = 'Phase 2/3: 열화 진행 (Degrading)';
            }

            return {
                x: row.mileage,
                y: parseFloat(directionalDI.toFixed(2)),
                L: parseFloat(row.L.toFixed(2)),
                a: parseFloat(row.a.toFixed(2)),
                b: parseFloat(row.b.toFixed(2)),
                phase: phase,
                needsReplacement: isSaturated || directionalDI > 45.0,
                pointColor: isSaturated ? '#8B0000' : (directionalDI > 12.0 ? '#FFA500' : '#0000FF'),
                isNew: row.isNew
            };
        });

        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // CORS 지원
            },
            body: JSON.stringify({ success: true, data: evaluatedData, vector: pc1 })
        };
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
};
