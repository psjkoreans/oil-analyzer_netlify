import json
import base64
import cv2
import numpy as np

def handler(event, context):
    try:
        # POST 메서드 검증
        if event.get('httpMethod') != 'POST':
            return {
                "statusCode": 405,
                "body": json.dumps({"error": "Method Not Allowed"})
            }

        # JSON 페이로드 파싱
        body_str = event.get('body', '{}')
        if not body_str:
            return {"statusCode": 400, "body": json.dumps({"error": "데이터가 누락되었습니다."})}
            
        content = json.loads(body_str)
        img_str = content.get('image')

        if not img_str:
            return {"statusCode": 400, "body": json.dumps({"error": "이미지 데이터가 없습니다."})}

        # Base64 이미지 디코딩 및 OpenCV 변환
        img_bytes = base64.b64decode(img_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return {"statusCode": 400, "body": json.dumps({"error": "이미지 해석 불가"})}

        # 핵심 로직: 마스킹 및 색차 분석
        h, w = img.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.circle(mask, (w // 2, h // 2), min(h, w) // 3, 255, -1)
        
        lab_img = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        avg_lab = cv2.mean(lab_img, mask=mask)
        l, a, b = avg_lab[0], avg_lab[1], avg_lab[2]

        # 기준값 및 Delta E 계산
        ref_l, ref_a, ref_b = 60.0, 142.0, 155.0 
        delta_e = float(np.sqrt((l - ref_l)**2 + (a - ref_a)**2 + (b - ref_b)**2))

        phase = "Phase 1: 신유" if delta_e < 20 else ("Phase 2: 주의" if delta_e < 45 else "Phase 3: 폐유")
        
        # 클라이언트 반환 규격 준수
        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json"
            },
            "body": json.dumps({
                "Delta_E": round(delta_e, 2),
                "Phase": phase,
                "Needs_Replacement": delta_e >= 45.0
            })
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }