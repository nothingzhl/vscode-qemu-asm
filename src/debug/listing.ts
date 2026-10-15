/** A single executable source line, with its physical real-mode address. */
export interface SourceEntry {
  readonly line: number;
  readonly address: number;
  readonly size: number;
  readonly text: string;
}

/** NASM's bin listing offsets become physical addresses at the boot load address. */
export class SourceMap {
  readonly entries: readonly SourceEntry[];
  private readonly lines = new Map<number, SourceEntry>();

  constructor(readonly sourcePath: string, readonly origin: number, entries: readonly SourceEntry[]) {
    this.entries = entries.map(entry => Object.freeze({ ...entry })).sort((a, b) => a.address - b.address);
    for (const entry of this.entries) this.lines.set(entry.line, entry);
  }

  /** Labels, comments and data never silently move a breakpoint onto another line. */
  forLine(line: number): SourceEntry | undefined { return this.lines.get(line); }

  /** Only bytes inside an instruction map to source; BIOS and data do not. */
  forAddress(address: number): SourceEntry | undefined {
    if (!Number.isSafeInteger(address)) return undefined;
    let low = 0;
    let high = this.entries.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const entry = this.entries[mid];
      if (address < entry.address) high = mid - 1;
      else if (address >= entry.address + entry.size) low = mid + 1;
      else return entry;
    }
    return undefined;
  }
}

type LineKind = 'instruction' | 'data' | 'other';
const dataDirectives = new Set('db dw dd dq dt do dy dz resb resw resd resq rest reso resy resz'.split(' '));
const prefixes = new Set('lock rep repe repz repne repnz bnd xacquire xrelease a16 a32 o16 o32 cs ds es fs gs ss notrack'.split(' '));
// Deliberately explicit: unrecognised pseudo-instructions must not become executable lines.
const instructions = new Set((
  'aaa aad aam aas adc add and arpl bound bsf bsr bswap bt btc btr bts call cbw cdq clc cld cli clts cmc cmp cmps cmpsb cmpsw cmpsd ' +
  'cmpxchg cmpxchg8b cpuid cwd cwde daa das dec div enter hlt idiv imul in inc ins insb insw insd int int1 int3 into invd invlpg ' +
  'iret iretd ja jae jb jbe jc jcxz jecxz je jg jge jl jle jmp jna jnae jnb jnbe jnc jne jng jnge jnl jnle jno jnp jns jnz jo jp jpe jpo js jz ' +
  'lahf lar lds lea leave les lfs lgdt lgs lidt lldt lmsw lods lodsb lodsw lodsd loop loope loopne loopnz loopz lsl lss ltr ' +
  'mov movs movsb movsw movsd movsx movzx mul neg nop not or out outs outsb outsw outsd pop popa popad popf popfd ' +
  'push pusha pushad pushf pushfd rcl rcr rdmsr rdpmc rdtsc ret retn retf rol ror rsm sahf sal sar sbb scas scasb scasw scasd ' +
  'seta setae setb setbe setc sete setg setge setl setle setna setnae setnb setnbe setnc setne setng setnge setnl setnle setno setnp setns setnz seto setp setpe setpo sets setz ' +
  'sgdt shl shld shr shrd sidt sldt smsw stc std sti stos stosb stosw stosd str sub test ud2 verr verw wait fwait wbinvd wrmsr xadd xchg xlat xlatb xor ' +
  'f2xm1 fabs fadd faddp fbld fbstp fchs fclex fcmovb fcmovbe fcmove fcmovnb fcmovnbe fcmovne fcmovnu fcmovu fcom fcomp fcompp ' +
  'fcos fdecstp fdiv fdivp fdivr fdivrp ffree fiadd ficom ficomp fidiv fidivr fild fimul fincstp finit fist fistp fisub fisubr ' +
  'fld fld1 fldcw fldenv fldl2e fldl2t fldlg2 fldln2 fldpi fldz fmul fmulp fnclex fninit fnop fnsave fnstcw fnstenv fnstsw ' +
  'fpatan fprem fprem1 fptan frndint frstor fsave fscale fsin fsincos fsqrt fst fstcw fstenv fstp fstsw fsub fsubp fsubr fsubrp ' +
  'ftst fucom fucomp fucompp fxam fxch fxtract fyl2x fyl2xp1'
).split(' '));
const identifier = '[A-Za-z_.$?@][A-Za-z0-9_.$?@]*';
const label = new RegExp(`^${identifier}\\s*:\\s*`);
const bareLabel = new RegExp(`^(${identifier})\\s+(.+)$`);

function fail(message: string, line?: number): never {
  throw new Error(`无法建立调试源码映射${line === undefined ? '' : `（第 ${line} 行）`}：${message}`);
}

/** Preserve quoted semicolons, but remove comments before inspecting directives. */
function codeWithoutComment(text: string, line: number): string {
  let quote = '';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      result += char;
      if (quote === '`' && char === '\\' && i + 1 < text.length) result += text[++i];
      else if (char === quote) quote = '';
    } else if (char === ';') break;
    else {
      if (char === '"' || char === "'" || char === '`') quote = char;
      if (char === '%') fail('首版调试不支持预处理器、include 或宏。请使用单文件源码', line);
      if (char === '\\') fail('首版调试不支持跨行语句', line);
      result += char;
    }
  }
  if (quote) fail('首版调试要求字符串在同一行闭合', line);
  return result.trim();
}

function constant(text: string, line: number): number {
  const value = text.replace(/_/g, '');
  let number: number;
  if (/^0x[0-9a-f]+$/i.test(value)) number = Number.parseInt(value.slice(2), 16);
  else if (/^0b[01]+$/i.test(value)) number = Number.parseInt(value.slice(2), 2);
  else if (/^0o[0-7]+$/i.test(value)) number = Number.parseInt(value.slice(2), 8);
  else if (/^[0-9][0-9a-f]*h$/i.test(value)) number = Number.parseInt(value.slice(0, -1), 16);
  else if (/^\d+$/.test(value)) number = Number(value);
  else fail('BITS / ORG 必须使用数字常量，不能使用符号或表达式', line);
  if (!Number.isSafeInteger(number)) fail('数字常量超出安全范围', line);
  return number;
}

function statement(text: string): string {
  while (label.test(text)) text = text.replace(label, '');
  // NASM permits "message db ..." and "start mov ..." without a colon.
  const match = bareLabel.exec(text);
  if (match && !instructions.has(match[1].toLowerCase()) && !prefixes.has(match[1].toLowerCase()) &&
      !dataDirectives.has(match[1].toLowerCase()) && !/^(bits|org|times|align|alignb)$/i.test(match[1])) {
    const next = match[2].split(/\s/, 1)[0].toLowerCase();
    if (dataDirectives.has(next) || instructions.has(next) || prefixes.has(next) || next === 'equ') text = match[2];
  }
  return text;
}

function inspectSource(lines: string[]): { kinds: LineKind[]; origin: number } {
  let origin: number | undefined;
  let hasBits = false;
  const kinds = lines.map((text, index): LineKind => {
    const line = index + 1;
    let code = codeWithoutComment(text, line);
    if (!code) return 'other';
    if (code.startsWith('[')) {
      if (!code.endsWith(']')) fail('无法识别 NASM 方括号指令', line);
      code = code.slice(1, -1).trim();
    }
    const directive = /^(bits|org)\s+(.+)$/i.exec(code);
    if (directive) {
      const value = constant(directive[2].trim(), line);
      if (directive[1].toLowerCase() === 'bits') {
        if (hasBits || value !== 16) fail('首版调试要求唯一的 BITS 16 声明', line);
        hasBits = true;
      } else {
        if (origin !== undefined || value !== 0x7c00) fail('首版调试要求唯一的 ORG 0x7c00，与 BIOS 引导加载地址一致', line);
        origin = value;
      }
      return 'other';
    }
    code = statement(code);
    if (!code) return 'other';
    let mnemonic = code.split(/\s/, 1)[0].toLowerCase();
    if (mnemonic === 'times') {
      const repeated = /^times\s+(.+?)\s+(db|dw|dd|dq|dt|do|dy|dz|resb|resw|resd|resq|rest|reso|resy|resz)\b/i.exec(code);
      if (!repeated || !/^[\dA-Fa-f_xXhHbBoOqQdD$()\s+*/<>&|^~!-]+$/.test(repeated[1])) {
        fail('TIMES 只支持数字或 $ / $$ 表达式的数据填充；重复指令不能设置可靠断点', line);
      }
      return 'data';
    }
    if (dataDirectives.has(mnemonic) || mnemonic === 'align' || mnemonic === 'alignb') return 'data';
    if (mnemonic === 'equ') return 'other';
    while (prefixes.has(mnemonic)) {
      code = code.slice(mnemonic.length).trim();
      mnemonic = code.split(/\s/, 1)[0].toLowerCase();
      if (!mnemonic) fail('指令前缀必须与指令写在同一行', line);
    }
    if (instructions.has(mnemonic)) return 'instruction';
    fail(`首版调试不支持语句“${mnemonic}”；请使用单文件 BITS 16 引导源码，不使用 section、incbin 或宏`, line);
  });
  if (!hasBits || origin === undefined) fail('首版调试要求显式 BITS 16 和 ORG 0x7c00');
  return { kinds, origin };
}

function listingSize(field: string, line: number): number {
  let value = field.trim().replace(/-$/, '');
  const reserved = /^<res ([0-9a-f]+)h>$/i.exec(value);
  if (reserved) return Number.parseInt(reserved[1], 16);
  let repeat = 1;
  const repeated = /<rep ([0-9a-f]+)h>$/i.exec(value);
  if (repeated) {
    repeat = Number.parseInt(repeated[1], 16);
    value = value.slice(0, repeated.index);
  }
  value = value.replace(/[\[\]()]/g, '');
  if (!/^(?:[0-9a-f]{2}|\?\?)+$/i.test(value)) fail('无法识别 NASM listing 机器码字段', line);
  const size = value.length / 2 * repeat;
  if (!Number.isSafeInteger(size) || size <= 0) fail('listing 机器码长度无效', line);
  return size;
}

/**
 * Parse an actual NASM `-f bin -l` listing. This first debugger intentionally
 * rejects preprocessing and mode/section changes instead of inventing mappings.
 */
export function parseListing(listing: string, sourcePath: string, sourceText: string): SourceMap {
  const lines = sourceText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const { kinds, origin } = inspectSource(lines);
  const seenSource = new Set<number>();
  const entries = new Map<number, SourceEntry>();
  let previousEnd = 0;
  for (const row of listing.replace(/\r\n/g, '\n').split('\n')) {
    if (!row.trim()) continue;
    // NASM's standard listing has a six-column line number and source at col 41.
    if (!/^\s*\d+ /.test(row.slice(0, 7))) fail('无法识别 listing 行号或格式');
    const line = Number(row.slice(0, 6).trim());
    if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) fail('listing 行号不在当前源文件中');
    const offsetText = row.slice(7, 15).trim();
    const field = row.slice(16, 40).trim();
    if (!offsetText && /^\*+$/.test(field)) continue; // A NASM warning, not a source/byte row.
    const original = row.slice(40).trimEnd();
    if (original || !seenSource.has(line)) {
      if (original !== lines[line - 1].trimEnd()) fail('listing 与当前源文件内容不同，请重新构建', line);
      seenSource.add(line);
    }
    if (!offsetText) {
      if (field) fail('首版调试不支持宏展开或额外 listing 字段', line);
      continue;
    }
    if (!/^[0-9a-f]{8}$/i.test(offsetText)) fail('无法识别 listing 文件偏移', line);
    const offset = Number.parseInt(offsetText, 16);
    const size = listingSize(field, line);
    if (offset !== previousEnd) fail('listing 地址重复或不连续，无法可靠映射', line);
    previousEnd = offset + size;
    if (!Number.isSafeInteger(previousEnd) || origin + previousEnd > 0x10000) fail('首版调试不支持跨越 16 位地址边界的镜像', line);
    if (kinds[line - 1] === 'other') fail('非指令语句产生了机器码，首版无法可靠映射', line);
    if (kinds[line - 1] !== 'instruction') continue;
    const existing = entries.get(line);
    if (existing) {
      if (existing.address + existing.size !== origin + offset) fail('同一源码行的机器码不连续', line);
      entries.set(line, { ...existing, size: existing.size + size });
    } else entries.set(line, { line, address: origin + offset, size, text: lines[line - 1] });
    if ((entries.get(line)?.size ?? 0) > 15) fail('一行对应超过一条 x86 指令，不能设置可靠断点', line);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!seenSource.has(i + 1)) fail('listing 缺少当前源码行，请重新构建', i + 1);
    if (kinds[i] === 'instruction' && !entries.has(i + 1)) fail('指令缺少机器码，无法可靠映射', i + 1);
  }
  if (!entries.size) fail('源文件中没有可调试指令');
  return new SourceMap(sourcePath, origin, [...entries.values()]);
}
