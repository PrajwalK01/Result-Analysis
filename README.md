# Result Analysis System

A web-based VTU result analysis portal for **Jnanavikas Institute of Technology**.

Built with **Flask + Firebase Firestore**, following the **VTU 2025/2022/2021 grading scheme**.

---

## Features

- Upload student marksheets (single or multiple images for reference)
- Enter subject-wise Internal / External marks
- Auto-calculates **Total, Grade Point, Letter Grade, SGPA, Percentage, Class Awarded**
- Dashboard with **Toppers, Class Distribution, Subject-wise Analysis**
- **Download CSV** of full results
- Brute-force protected login (5 attempts → 5-min lockout)
- Role-based access (ResultAnalysis role only)

## VTU Grading (2025 / 2022 / 2021 Scheme)

| Marks  | Letter | Grade Point |
|--------|--------|-------------|
| 90–100 | O      | 10          |
| 80–89  | A+     | 9           |
| 70–79  | A      | 8           |
| 60–69  | B+     | 7           |
| 55–59  | B      | 6           |
| 50–54  | C      | 5           |
| 40–49  | P      | 4           |
| 0–39   | F      | 0           |

**SGPA** = Σ(Grade Point × Credit) / Σ(Credits)

**Class:** FCD ≥ 75% · FC ≥ 60% · SC ≥ 45% · NC < 45% or any F

## Setup

```bash
# 1. Clone
git clone https://github.com/PrajwalK01/Result-Analysis.git
cd Result-Analysis

# 2. Create virtual environment
python -m venv venv
venv\Scripts\activate      # Windows
source venv/bin/activate   # Linux/macOS

# 3. Install dependencies
pip install -r requirements.txt

# 4. Add Firebase credentials
# Place your firebase-key.json in the project root (never commit this file)

# 5. Run
python app.py
```

Visit `http://127.0.0.1:5000`

## Version

**v1.0.0** — Initial release
