'use client';
// app/page.jsx
// 예약 화면 (클라이언트 컴포넌트). fetch 로 자기 API(/api/*)를 호출한다.

import { useEffect, useState, useCallback } from 'react';

// 오늘 날짜를 'YYYY-MM-DD' 로
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export default function Page() {
  const [config, setConfig] = useState(null);
  const [machine, setMachine] = useState('');
  const [date, setDate] = useState(todayStr());
  const [reservations, setReservations] = useState([]); // 현재 machine+date 예약목록
  const [selected, setSelected] = useState([]);         // 사용자가 고른 빈 시간들
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [memo, setMemo] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // 초기: CONFIG 로드
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        setConfig(cfg);
        setMachine(cfg.machines[0]);
      })
      .catch(() => setMessage('설정을 불러오지 못했습니다.'));
  }, []);

  // 현황 조회
  const loadReservations = useCallback(async () => {
    if (!machine || !date) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/reservations?machine=${encodeURIComponent(machine)}&date=${date}`
      );
      const data = await res.json();
      setReservations(data.reservations || []);
      setSelected([]); // 날짜/장비 바뀌면 선택 초기화
    } catch {
      setMessage('예약현황을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [machine, date]);

  useEffect(() => {
    loadReservations();
  }, [loadReservations]);

  if (!config) {
    return <main style={styles.main}>불러오는 중…</main>;
  }

  // 시간 목록 (8..19)
  const hours = [];
  for (let h = config.startHour; h < config.endHour; h++) hours.push(h);

  // hour → 예약 정보 매핑
  const byHour = {};
  for (const r of reservations) byHour[r.hour] = r;

  // 빈 시간 클릭 → 토글 선택
  function toggleSelect(h) {
    setMessage('');
    setSelected((prev) =>
      prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h].sort((a, b) => a - b)
    );
  }

  // 예약된 시간 클릭 → 취소 시도
  async function handleCancel(r) {
    if (!name.trim()) {
      setMessage('취소하려면 하단에 예약자 이름을 입력해 주세요.');
      return;
    }
    if (!confirm(`${r.hour}시 (${r.name}) 예약을 취소할까요?`)) return;
    setLoading(true);
    try {
      const res = await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, name: name.trim() }),
      });
      const data = await res.json();
      setMessage(data.error || data.message);
      await loadReservations();
    } catch {
      setMessage('취소 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  // 예약하기
  async function handleReserve() {
    if (selected.length === 0) {
      setMessage('예약할 시간을 먼저 선택해 주세요.');
      return;
    }
    if (!name.trim()) {
      setMessage('예약자 이름을 입력해 주세요.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine,
          date,
          hours: selected,
          name: name.trim(),
          dept,
          memo,
          email,
        }),
      });
      const data = await res.json();
      setMessage(data.error || data.message);
      if (data.ok) {
        setSelected([]);
        setMemo('');
      }
      await loadReservations();
    } catch {
      setMessage('예약 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>진동시험기 예약</h1>

      {/* 장비 선택 (1개면 고정 표시) */}
      <div style={styles.row}>
        <label style={styles.label}>장비</label>
        {config.machines.length === 1 ? (
          <span style={styles.fixed}>{config.machines[0]}</span>
        ) : (
          <select value={machine} onChange={(e) => setMachine(e.target.value)} style={styles.input}>
            {config.machines.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
      </div>

      {/* 날짜 선택 */}
      <div style={styles.row}>
        <label style={styles.label}>날짜</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={styles.input}
        />
      </div>

      {/* 시간 그리드 */}
      <div style={styles.grid}>
        {hours.map((h) => {
          const r = byHour[h];
          const isSel = selected.includes(h);
          if (r) {
            // 예약됨: 이름 표시, 클릭 시 취소
            return (
              <button
                key={h}
                onClick={() => handleCancel(r)}
                style={{ ...styles.cell, ...styles.cellTaken }}
                title="클릭하면 취소 (이름 일치 필요)"
              >
                <div style={styles.cellHour}>{String(h).padStart(2, '0')}:00</div>
                <div style={styles.cellName}>{r.name}</div>
              </button>
            );
          }
          // 빈칸: 클릭 토글
          return (
            <button
              key={h}
              onClick={() => toggleSelect(h)}
              style={{ ...styles.cell, ...(isSel ? styles.cellSelected : styles.cellFree) }}
            >
              <div style={styles.cellHour}>{String(h).padStart(2, '0')}:00</div>
              <div style={styles.cellName}>{isSel ? '선택됨' : '예약가능'}</div>
            </button>
          );
        })}
      </div>

      <p style={styles.hint}>
        빈칸을 눌러 시간을 선택(연속·최대 {config.maxHours}시간), 예약된 칸을 누르면 취소됩니다.
      </p>

      {/* 하단 폼 */}
      <div style={styles.form}>
        <div style={styles.formRow}>
          <label style={styles.label}>이름 *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={styles.input} placeholder="예약자 이름" />
        </div>
        <div style={styles.formRow}>
          <label style={styles.label}>부서</label>
          <input value={dept} onChange={(e) => setDept(e.target.value)} style={styles.input} placeholder="(선택)" />
        </div>
        <div style={styles.formRow}>
          <label style={styles.label}>메모</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} style={styles.input} placeholder="(선택)" />
        </div>
        <div style={styles.formRow}>
          <label style={styles.label}>이메일</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={styles.input} placeholder="(선택)" />
        </div>
        <button onClick={handleReserve} disabled={loading} style={styles.reserveBtn}>
          {loading ? '처리 중…' : `예약하기${selected.length ? ` (${selected.length}시간)` : ''}`}
        </button>
      </div>

      {/* 결과 메시지 */}
      {message && <div style={styles.message}>{message}</div>}

      {/* 확장 가능: 통계 / CSV 내보내기 / 반복예약 / 기간+이름 조회목록 등 */}
    </main>
  );
}

// 인라인 스타일 (초심자용 — 별도 CSS 없이 한 파일에서 파악)
const styles = {
  main: { maxWidth: 640, margin: '0 auto', padding: 16 },
  h1: { fontSize: 22, margin: '8px 0 16px' },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  label: { width: 56, fontSize: 14, color: '#555', flexShrink: 0 },
  fixed: { fontWeight: 600 },
  input: { flex: 1, padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 15 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
    gap: 8,
    marginTop: 12,
  },
  cell: {
    border: '1px solid #ddd',
    borderRadius: 8,
    padding: '10px 6px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  cellFree: { background: '#fff' },
  cellSelected: { background: '#d3e8ff', borderColor: '#4a90e2' },
  cellTaken: { background: '#ffe1e1', borderColor: '#e08a8a' },
  cellHour: { fontSize: 14, fontWeight: 600 },
  cellName: { fontSize: 12, color: '#555' },
  hint: { fontSize: 12, color: '#888', marginTop: 10 },
  form: { marginTop: 16, background: '#fff', border: '1px solid #eee', borderRadius: 10, padding: 14 },
  formRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  reserveBtn: {
    width: '100%',
    padding: '12px',
    background: '#2b6cb0',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
  },
  message: {
    marginTop: 14,
    padding: '10px 12px',
    background: '#fffbe6',
    border: '1px solid #ffe58f',
    borderRadius: 8,
    fontSize: 14,
  },
};
