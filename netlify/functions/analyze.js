exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const payload = JSON.parse(event.body);

        // 1. 누적 적분을 위한 시계열(주행거리) 기반 오름차순 정렬
        payload.sort((a, b) => a.mileage - b.mileage);

        // 2. sRGB를 비선형 CIE L*a*b* 색공간으로 변환하는 알고리즘
        const rgbToLab = (r, g, b) => {
            let r_l = r / 255.0;
            let g_l = g / 255.0;
            let b_l = b / 255.0;

            r_l = r_l > 0.04045 ? Math.pow((r_l + 0.055) / 1.055, 2.4) : r_l / 12.92;
            g_l = g_l > 0.04045 ? Math.pow((g_l + 0.055) / 1.055, 2.4) : g_l / 12.92;
            b_l = b_l > 0.04045 ? Math.pow((b_l + 0.055) / 1.055, 2.4) : b_l / 12.92;

            let x = (r_l * 0.4124 + g_l * 0.3576 + b_l * 0.1805) * 100;
            let y = (r_l * 0.2126 + g_l * 0.7152 + b_l * 0.0722) * 100;
            let z = (r_l * 0.0193 + g_l * 0.1192 + b_l * 0.9505) * 100;

            x = x / 95.047;
            y = y / 100.000;
            z = z / 108.883;

            x = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x) + (16 / 116);
            y = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y) + (16 / 116);
            z = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z) + (16 / 116);

            return {
                L: (116 * y) - 16,
                a: 500 * (x - y),
                b: 200 * (y - z)
            };
        };

        let cumulative_di = 0.0;
        const evaluatedData = [];

        // 3. 누적 색차 기반 유클리드 거리 적분 및 상태 기계 산출
        for (let i = 0; i < payload.length; i++) {
            let row = payload[i];
            const lab = rgbToLab(row.r, row.g, row.b);
            
            row.L = lab.L;
            row.a = lab.a;
            row.b = lab.b;

            if (i === 0) {
                cumulative_di = 0.0;
            } else {
                const prevRow = evaluatedData[i - 1];
                const delta_e = Math.sqrt(
                    Math.pow(row.L - prevRow.L, 2) + 
                    Math.pow(row.a - prevRow.a, 2) + 
                    Math.pow(row.b - prevRow.b, 2)
                );
                cumulative_di += delta_e;
            }

            row.DI = cumulative_di;
            const is_saturated = row.L < 30.0;
            
            let phase, color;
            if (is_saturated || cumulative_di >= 250.0) {
                phase = 'Phase 5: 즉시 교체 필요 (Limit Reached)'; color = '#000000';
            } else if (cumulative_di >= 225.0) {
                phase = 'Phase 4: 심화 열화(교체 필요)'; color = '#8B0000';
            } else if (cumulative_di >= 200.0) {
                phase = 'Phase 3: 심화 열화 진행'; color = '#FF0000';
            } else if (cumulative_di >= 100.0) {
                phase = 'Phase 2: 열화 진행'; color = '#FFA500';
            } else {
                phase = 'Phase 1: 초기 열화 또는 신유'; color = '#FFD700';
            }

            row.phase = phase;
            row.color = color;
            row.needsReplacement = (is_saturated || cumulative_di >= 250.0);
            
            evaluatedData.push(row);
        }

        // 4. 클라이언트 전송용 규격 매핑
        const chartData = evaluatedData.map(d => ({
            x: d.mileage,
            L: d.L,
            a: d.a,
            b: d.b,
            y: d.DI,
            phase: d.phase,
            needsReplacement: d.needsReplacement,
            isNew: d.isNew,
            pointColor: d.color
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: chartData })
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
