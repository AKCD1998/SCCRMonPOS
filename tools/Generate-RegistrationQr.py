"""Build bundled terminal QR assets offline (qrcode==8.2); verify with OpenCV.

Run: py tools/Generate-RegistrationQr.py [--web-output PATH]
The optional PATH is the website's backend/public/member-registration/referrals.
No customer, session, credential, or external QR service is involved.
"""
import argparse
from pathlib import Path
import shutil
import cv2
import qrcode

parser = argparse.ArgumentParser()
parser.add_argument('--web-output', type=Path)
args = parser.parse_args()
output = Path(__file__).resolve().parents[1] / 'SCCRMonPOS/Assets/RegistrationQr'
output.mkdir(parents=True, exist_ok=True)
if args.web_output:
    args.web_output.mkdir(parents=True, exist_ok=True)
for branch in ['001', '003', '004', '005']:
    for pos in ['001', '002']:
        code = f'{branch}-{pos}'
        url = f'https://sc-official-website.onrender.com/join/r/{code}'
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        qr.add_data(url)
        qr.make(fit=True)
        filename = output / f'{code}.png'
        qr.make_image(fill_color='black', back_color='white').save(filename)
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(filename)))
        if decoded != url:
            raise RuntimeError(f'QR decode mismatch for {code}')
        if args.web_output:
            shutil.copyfile(filename, args.web_output / filename.name)
        print(f'{code}: decoded URL verified')
