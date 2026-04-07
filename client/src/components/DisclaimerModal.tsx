import React from 'react';
import { Modal, Button } from 'react-bootstrap';

interface DisclaimerModalProps {
  show: boolean;
  onClose: () => void;
}

const DisclaimerModal: React.FC<DisclaimerModalProps> = ({ show, onClose }) => {
  return (
    <Modal show={show} onHide={onClose} size="lg" centered>
      <Modal.Body style={{ padding: '2rem' }}>
        <style>
          {`
            [data-custom-class='body'], [data-custom-class='body'] * { background: transparent !important; }
            [data-custom-class='title'], [data-custom-class='title'] * { font-family: Arial !important; font-size: 26px !important; color: #000000 !important; }
            [data-custom-class='subtitle'], [data-custom-class='subtitle'] * { font-family: Arial !important; color: #595959 !important; font-size: 14px !important; }
            [data-custom-class='heading_1'], [data-custom-class='heading_1'] * { font-family: Arial !important; font-size: 19px !important; color: #000000 !important; }
            [data-custom-class='heading_2'], [data-custom-class='heading_2'] * { font-family: Arial !important; font-size: 17px !important; color: #000000 !important; }
            [data-custom-class='body_text'], [data-custom-class='body_text'] * { color: #595959 !important; font-size: 14px !important; font-family: Arial !important; }
            [data-custom-class='link'], [data-custom-class='link'] * { color: #3030F1 !important; font-size: 14px !important; font-family: Arial !important; word-break: break-word !important; }
            ul { list-style-type: square; }
            ul > li > ul { list-style-type: circle; }
            ul > li > ul > li > ul { list-style-type: square; }
            ol li { font-family: Arial; }
          `}
        </style>
        <div data-custom-class="body">
          <div className="MsoNormal" data-custom-class="title" style={{ textAlign: 'left', lineHeight: '1.5' }}>
            <strong><h1>DISCLAIMER</h1></strong>
          </div>
          <div className="MsoNormal" data-custom-class="heading_1">
             <strong><h2>WEBSITE DISCLAIMER</h2></strong>
          </div>
          <div className="MsoNormal" data-custom-class="body_text" style={{ lineHeight: '1.5' }}>
            <span>The information provided by Macros100 is for general informational purposes only. All information on the Site and our mobile application is provided in good faith, however we make no representation or warranty of any kind, express or implied, regarding the accuracy, adequacy, validity, reliability, availability, or completeness of any information on the Site or our mobile application. UNDER NO CIRCUMSTANCE SHALL WE HAVE ANY LIABILITY TO YOU FOR ANY LOSS OR DAMAGE OF ANY KIND INCURRED AS A RESULT OF THE USE OF THE SITE OR OUR MOBILE APPLICATION OR RELIANCE ON ANY INFORMATION PROVIDED ON THE SITE AND OUR MOBILE APPLICATION. YOUR USE OF THE SITE AND OUR MOBILE APPLICATION AND YOUR RELIANCE ON ANY INFORMATION ON THE SITE AND OUR MOBILE APPLICATION IS SOLELY AT YOUR OWN RISK.</span>
          </div>
          <div className="MsoNormal" data-custom-class="heading_1">
            <strong><h2>PROFESSIONAL DISCLAIMER</h2></strong>
          </div>
          <div className="MsoNormal" data-custom-class="body_text" style={{ lineHeight: '1.5' }}>
            <span>The Site cannot and does not contain medical/health advice. The medical/health information is provided for general informational and educational purposes only and is not a substitute for professional advice. Accordingly, before taking any actions based upon such information, we encourage you to consult with the appropriate professionals. We do not provide any kind of medical/health advice. THE USE OR RELIANCE OF ANY INFORMATION CONTAINED ON THE SITE OR OUR MOBILE APPLICATION IS SOLELY AT YOUR OWN RISK.</span>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="primary" onClick={onClose}>I Understand</Button>
      </Modal.Footer>
    </Modal>
  );
};

export default DisclaimerModal;
