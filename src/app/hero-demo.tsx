"use client";

import { useEffect, useRef, useState } from "react";

const SCENES = [
  "Pick your board, grade & subjects",
  "Ask anything, get a syllabus-scoped answer",
  "Practice real exam patterns",
  "Answers in your own language",
];

const SCENE_DURATION_MS = 4200;

export default function HeroDemo() {
  const [scene, setScene] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      setScene((s) => (s + 1) % SCENES.length);
    }, SCENE_DURATION_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scene]);

  function selectScene(i: number) {
    setScene(i);
  }

  return (
    <div className="mt-12 w-full max-w-3xl">
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_32px_64px_-32px_rgba(20,20,19,0.25)]">
        <div className="flex items-center gap-2 border-b border-border bg-background px-5 py-3.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
          <span className="ml-3 text-xs font-semibold text-foreground/45">
            syllabusmate.in/dashboard
          </span>
        </div>

        <div className="relative min-h-[380px] text-left">
          {/* Scene 0: pick your board/grade/subjects */}
          <Scene active={scene === 0}>
            <div className="flex flex-col gap-4 p-6">
              <div className="flex flex-wrap gap-2.5">
                <Pill>CBSE ▾</Pill>
                <Pill>Grade 10 ▾</Pill>
                <Pill>English ▾</Pill>
              </div>
              <Eyebrow>Choose your subjects</Eyebrow>
              <div className="flex flex-wrap gap-2">
                <SubjectTag active>Social Science</SubjectTag>
                <SubjectTag>Mathematics</SubjectTag>
                <SubjectTag>Science</SubjectTag>
                <SubjectTag>English</SubjectTag>
              </div>
              <div className="mt-1 border-t border-border pt-3.5">
                <Eyebrow>Social Science syllabus</Eyebrow>
                <div className="mt-2 flex max-w-xs flex-col gap-0.5">
                  <TopicRow>Resources and Development</TopicRow>
                  <TopicRow active>Agriculture</TopicRow>
                  <TopicRow>Water Resources</TopicRow>
                </div>
              </div>
            </div>
          </Scene>

          {/* Scene 1: ask a question, get a syllabus-scoped answer */}
          <Scene active={scene === 1}>
            <div className="flex h-full">
              <div className="w-[200px] flex-shrink-0 border-r border-border bg-background px-3.5 py-4">
                <Eyebrow className="px-2">Social Science</Eyebrow>
                <div className="mt-2 flex flex-col gap-0.5">
                  <TopicRow>Resources and Development</TopicRow>
                  <TopicRow active>Agriculture</TopicRow>
                  <TopicRow>Water Resources</TopicRow>
                  <TopicRow>Manufacturing Industries</TopicRow>
                </div>
              </div>
              <div className="flex flex-grow flex-col gap-4 px-6 py-5">
                <div className="max-w-[70%] self-end rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-[13.5px] leading-relaxed text-white">
                  What are the three cropping seasons in India?
                </div>
                <div className="max-w-[78%] self-start rounded-2xl rounded-bl-sm bg-background px-4 py-3 text-[13.5px] leading-relaxed text-foreground/85">
                  India has three cropping seasons: <strong>Rabi</strong>{" "}
                  (sown Oct–Dec, harvested Apr–Jun, e.g. wheat, mustard),{" "}
                  <strong>Kharif</strong> (sown with the monsoon, e.g. rice,
                  cotton), and <strong>Zaid</strong>, a short summer season
                  for crops like watermelon and cucumber.
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-border pt-3.5">
                  <span className="text-xs text-foreground/45">
                    Free trial · 3,240 of 5,000 tokens left
                  </span>
                  <span className="text-xs font-bold text-brand">
                    Subscribe
                  </span>
                </div>
              </div>
            </div>
          </Scene>

          {/* Scene 2: practice real exam patterns */}
          <Scene active={scene === 2}>
            <div className="flex flex-col gap-4 p-6">
              <Eyebrow>Practice a specific pattern</Eyebrow>
              <div className="flex flex-wrap gap-2">
                <SubjectTag active>Define a term (4)</SubjectTag>
                <SubjectTag>Explain with example (6)</SubjectTag>
                <SubjectTag>Case-based question (3)</SubjectTag>
              </div>
              <div className="rounded-xl border border-border bg-background p-4">
                <p className="mb-3 text-[13.5px] font-semibold">
                  Which of the following is a Kharif crop?
                </p>
                <div className="flex flex-col gap-2 text-[13px]">
                  <Option>Wheat</Option>
                  <Option selected>Rice</Option>
                  <Option>Mustard</Option>
                </div>
              </div>
            </div>
          </Scene>

          {/* Scene 3: answers in your own language */}
          <Scene active={scene === 3}>
            <div className="flex flex-col gap-4 p-6">
              <div className="flex gap-2">
                <span className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground/60">
                  English
                </span>
                <span className="rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-white">
                  বাংলা
                </span>
              </div>
              <div className="max-w-[72%] self-end rounded-2xl rounded-br-sm bg-brand px-4 py-2.5 text-[13.5px] leading-relaxed text-white">
                ভারতের তিনটি প্রধান চাষের ঋতু কী কী?
              </div>
              <div className="max-w-[88%] self-start rounded-2xl rounded-bl-sm bg-background px-4 py-3 text-[13.5px] leading-loose text-foreground/85">
                ভারতে তিনটি প্রধান চাষের ঋতু আছে: <strong>রবি</strong>{" "}
                (শীতকালে বোনা হয়, যেমন গম), <strong>খরিফ</strong>{" "}
                (বর্ষায় বোনা হয়, যেমন ধান), এবং <strong>জায়েদ</strong>,
                গ্রীষ্মের একটি সংক্ষিপ্ত ঋতু।
              </div>
            </div>
          </Scene>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-center">
        <span className="text-sm font-semibold text-foreground/70">
          {SCENES[scene]}
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-center gap-2">
        {SCENES.map((label, i) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            onClick={() => selectScene(i)}
            className={`h-2 w-2 rounded-full transition-colors ${
              scene === i ? "bg-brand" : "bg-border"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function Scene({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`absolute inset-0 transition-all duration-500 ease-out ${
        active
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2.5 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-lg border border-border bg-surface px-3.5 py-2 text-[13px] font-semibold">
      {children}
    </span>
  );
}

function Eyebrow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`text-[11px] font-bold uppercase tracking-wide text-foreground/45 ${className}`}
    >
      {children}
    </div>
  );
}

function SubjectTag({
  active,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold ${
        active
          ? "bg-brand text-white"
          : "border border-border text-foreground/65"
      }`}
    >
      {children}
    </span>
  );
}

function TopicRow({
  active,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg px-2.5 py-2 text-[13px] ${
        active
          ? "bg-brand/10 font-bold text-brand"
          : "text-foreground/70"
      }`}
    >
      {children}
    </div>
  );
}

function Option({
  selected,
  children,
}: {
  selected?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`h-4 w-4 flex-shrink-0 rounded-full ${
          selected ? "border-[5px] border-brand" : "border-2 border-border"
        }`}
      />
      <span
        className={selected ? "font-bold text-brand" : "text-foreground/70"}
      >
        {children}
      </span>
    </div>
  );
}
