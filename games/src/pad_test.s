; Pad Test - shows what the console gets from pad 1: each of the twelve buttons lights while it is held and
; counts its presses. A clock counts the frames (60 a second), and a ball crosses the screen one pixel a frame,
; to see that the picture runs at full speed and evenly. The sound chip beeps as each second begins on the
; clock, to hear how far the sound trails the picture, and hums while a button is held, to hear how far it
; trails the pad. Marks in the four corners show that the whole picture is on the screen.
;
; Written for snes-idrive, to try the app without a game of one's own. MIT (LICENSE at the repository's top).

.p816
.smart -

; ---------- the console's registers ----------
INIDISP  = $2100                ; the screen: off ($80), brightness
OBJSEL   = $2101                ; sprites: sizes, where their tiles are
OAMADDL  = $2102
OAMADDH  = $2103
OAMDATA  = $2104
BGMODE   = $2105
BG1SC    = $2107                ; background 1: where its map is
BG12NBA  = $210B                ; where the tiles of backgrounds 1 and 2 are
BG1HOFS  = $210D
BG1VOFS  = $210E
VMAIN    = $2115
VMADDL   = $2116
VMDATAL  = $2118
VMDATAH  = $2119
CGADD    = $2121
CGDATA   = $2122
TM       = $212C                ; what is on the screen
APUIO0   = $2140                ; the four ports to the sound chip's processor
APUIO1   = $2141
APUIO2   = $2142
APUIO3   = $2143
NMITIMEN = $4200                ; the frame interrupt, and the console's own reading of the pads
RDNMI    = $4210
HVBJOY   = $4212
JOY1L    = $4218                ; pad 1 as the console read it: B Y Select Start Up Down Left Right, A X L R

MAP      = $0400                ; background 1's map in video memory (in words), 32 x 32 tiles
SPRITES  = $2000                ; the sprites' tiles
LIT      = $01                  ; tiles (games/mkchr.js): a light that is on,
CORNER   = $02                  ; the four corner marks (bottom left, bottom right, top left, top right),
TRACK    = $06                  ; the ball's track
ROW0     = 7                    ; the first button's row; one button every two rows
TIMEROW  = 20
BALLROW  = 23
TONE     = $04                  ; the sound chip's pitch, high byte: 500 Hz while a button is held,
BEEP     = $08                  ; 1000 Hz as a second begins
BEEPLEN  = 6                    ; for this many frames
SPC_BASE = $0200                ; where the sound chip's program goes in its memory

.segment "ZEROPAGE"
pad:        .res 2              ; the buttons held now, as JOY1L has them
was:        .res 2              ; and a frame ago
new:        .res 2              ; pressed since
tick:       .res 1              ; frames into the tenth of a second
ballx:      .res 1
ballback:   .res 1              ; 1: the ball goes left
beep:       .res 1              ; frames the second's beep still sounds
sndcmd:     .res 1              ; what the sound chip was told last

.segment "BSS"
count:      .res 36             ; three digits a button
time:       .res 5              ; minutes (2 digits), seconds (2), tenths

.segment "RODATA"
; a button: its bit in JOY1L, and where its light is on the map (its count is three tiles further on)
.define LIGHT(col, n) MAP + (ROW0 + 2 * n) * 32 + col
masks:
    .word $0800, $0400, $0200, $0100, $2000, $1000          ; Up Down Left Right Select Start
    .word $8000, $0080, $4000, $0040, $0020, $0010          ; B A Y X L R
lights:
    .word LIGHT 9, 0
    .word LIGHT 9, 1
    .word LIGHT 9, 2
    .word LIGHT 9, 3
    .word LIGHT 9, 4
    .word LIGHT 9, 5
    .word LIGHT 25, 0
    .word LIGHT 25, 1
    .word LIGHT 25, 2
    .word LIGHT 25, 3
    .word LIGHT 25, 4
    .word LIGHT 25, 5
limits:
    .byte 10, 10, 6, 10, 10

; the texts: where on the map, the characters, 0; the list ends with $FFFF
.macro TEXT col, row, str
    .word MAP + (row) * 32 + (col)
    .byte str, 0
.endmacro
texts:
    TEXT 9, 2, "SNES PAD TEST"
    TEXT 3, 4, "BUTTONS LIGHT UP AND COUNT"
    TEXT 1, ROW0 + 0,  "UP     [ ] 000  B      [ ] 000"
    TEXT 1, ROW0 + 2,  "DOWN   [ ] 000  A      [ ] 000"
    TEXT 1, ROW0 + 4,  "LEFT   [ ] 000  Y      [ ] 000"
    TEXT 1, ROW0 + 6,  "RIGHT  [ ] 000  X      [ ] 000"
    TEXT 1, ROW0 + 8,  "SELECT [ ] 000  L      [ ] 000"
    TEXT 1, ROW0 + 10, "START  [ ] 000  R      [ ] 000"
    TEXT 10, TIMEROW, "TIME 00:00.0"
    TEXT 1, TIMEROW + 5, "A BEEP AS EACH SECOND BEGINS"
    .word MAP
    .byte CORNER + 2, 0
    .word MAP + 31
    .byte CORNER + 3, 0
    .word MAP + 27 * 32
    .byte CORNER, 0
    .word MAP + 27 * 32 + 31
    .byte CORNER + 1, 0
    .word MAP + BALLROW * 32 + 1
    .repeat 30
    .byte TRACK
    .endrepeat
    .byte 0
    .word $FFFF

; colours 0 to 3 of the background, and 0 to 3 of the sprites: blue-black, white, green, red
palette:
    .word $1400, $7FFF, $03E0, $001F

font:
    .incbin "font.bin"
font_end:
ball:
    .incbin "ball.bin"
ball_end:

; The sound chip's program (SPC700 code; cc65 has no assembler for it, so here it is as its bytes), and behind
; it at $0300 one sample: a square wave of sixteen samples, played over and over. The program waits for port 0
; to be 0 once, then does what port 0 says whenever it changes: 0 is quiet, anything else is that pitch (its
; high byte; $08 is 1000 Hz).
spc:
    .byte $8F, $6C, $F2,  $8F, $20, $F3     ; 0200  FLG: not muted, no echo written
    .byte $8F, $0C, $F2,  $8F, $60, $F3     ; 0206  main volume, left
    .byte $8F, $1C, $F2,  $8F, $60, $F3     ; 020C  main volume, right
    .byte $8F, $5D, $F2,  $8F, $03, $F3     ; 0212  the samples' list is at $0300
    .byte $8F, $00, $F2,  $8F, $7F, $F3     ; 0218  voice 0: volume left
    .byte $8F, $01, $F2,  $8F, $7F, $F3     ; 021E  volume right
    .byte $8F, $04, $F2,  $8F, $00, $F3     ; 0224  sample 0
    .byte $8F, $05, $F2,  $8F, $00, $F3     ; 022A  no envelope: the gain below
    .byte $8F, $07, $F2,  $8F, $7F, $F3     ; 0230  gain: full
    .byte $8F, $2C, $F2,  $8F, $00, $F3     ; 0236  echo volume left
    .byte $8F, $3C, $F2,  $8F, $00, $F3     ; 023C  echo volume right
    .byte $8F, $4D, $F2,  $8F, $00, $F3     ; 0242  no voice into the echo
    .byte $8F, $3D, $F2,  $8F, $00, $F3     ; 0248  no noise
    .byte $8F, $2D, $F2,  $8F, $00, $F3     ; 024E  no pitch modulation
    .byte $8F, $00, $00                     ; 0254  mov $00,#0       what was asked last: quiet
    .byte $E4, $F4                          ; 0257  mov a,$F4        wait for the console to say 0
    .byte $D0, $FC                          ; 0259  bne $0257
    .byte $E4, $F4                          ; 025B  mov a,$F4        what the console asks for
    .byte $64, $00                          ; 025D  cmp a,$00
    .byte $F0, $FA                          ; 025F  beq $025B        nothing new
    .byte $C4, $00                          ; 0261  mov $00,a
    .byte $68, $00                          ; 0263  cmp a,#0
    .byte $F0, $19                          ; 0265  beq $0280        quiet
    .byte $8F, $03, $F2                     ; 0267  voice 0's pitch, high byte:
    .byte $C4, $F3                          ; 026A  mov $F3,a        what was asked
    .byte $8F, $02, $F2,  $8F, $00, $F3     ; 026C  low byte 0
    .byte $8F, $5C, $F2,  $8F, $00, $F3     ; 0272  no key is let go
    .byte $8F, $4C, $F2,  $8F, $01, $F3     ; 0278  key on, voice 0
    .byte $2F, $DB                          ; 027E  bra $025B
    .byte $8F, $5C, $F2,  $8F, $01, $F3     ; 0280  key off, voice 0
    .byte $2F, $D3                          ; 0286  bra $025B
    .res $0300 - $0288, 0
    .word $0304, $0304                      ; 0300  sample 0 starts at $0304 and loops to $0304
    .byte $B3                               ; 0304  one block: shift 11, no filter, loop, the last
    .byte $77, $77, $77, $77, $99, $99, $99, $99    ; eight samples up, eight down
spc_end:
SPC_SIZE = spc_end - spc
.assert SPC_SIZE = $010D, error, "the sound chip's program moved: its jumps and the list at $0300 are written for these addresses"

.segment "CODE"

.a8
.i16
reset:
    sei
    clc
    xce                         ; the 65816 itself, not the 6502 it starts as
    rep #$18                    ; no decimal mode, 16-bit X and Y
    sep #$20                    ; 8-bit A
    ldx #$1FFF
    txs
    rep #$20
.a16
    lda #$0000
    tcd                         ; the direct page at 0
    sep #$20
.a8
    phk
    plb                         ; data in this bank
    lda #$8F
    sta INIDISP                 ; the screen off
    stz NMITIMEN

    ; every register of the picture to 0 (the scroll registers take two writes each)
    ldx #OBJSEL
:   stz a:$0000,x
    inx
    cpx #$2134
    bne :-
    ldx #BG1HOFS
:   stz a:$0000,x
    inx
    cpx #VMAIN
    bne :-
    lda #$FF                    ; background 1 a line up: the console starts with a map's second line
    sta BG1VOFS
    lda #$03
    sta BG1VOFS

    ; this program's memory
    ldx #$0000
:   stz a:$0000,x
    inx
    cpx #$0400
    bne :-
    lda #8
    sta ballx

    ; the colours: the same four for the background and for the sprites
    stz CGADD
    jsr colours
    lda #$80
    sta CGADD
    jsr colours

    ; the tiles: the letters at the start of video memory, the ball where the sprites' are
    lda #$80
    sta VMAIN                   ; a word at a time
    ldx #$0000
    stx VMADDL
:   lda font,x
    sta VMDATAL
    lda font+1,x
    sta VMDATAH
    inx
    inx
    cpx #(font_end - font)
    bne :-
    ldx #SPRITES
    stx VMADDL
    ldx #$0000
:   lda ball,x
    sta VMDATAL
    lda ball+1,x
    sta VMDATAH
    inx
    inx
    cpx #(ball_end - ball)
    bne :-

    ; the map: empty, then the texts
    ldx #MAP
    stx VMADDL
    ldx #1024
    lda #' '
:   sta VMDATAL
    stz VMDATAH
    dex
    bne :-
    ldx #texts
    jsr print_table

    ; the sprites: all of them below the picture; the ball is the first
    stz OAMADDL
    stz OAMADDH
    ldx #128
:   stz OAMDATA
    lda #240
    sta OAMDATA
    stz OAMDATA
    stz OAMDATA
    dex
    bne :-
    ldx #32
:   stz OAMDATA
    dex
    bne :-

    stz BGMODE                  ; mode 0: four colours a background, 8 x 8 tiles
    lda #(MAP >> 8)             ; the map at MAP, 32 x 32
    sta BG1SC
    stz BG12NBA                 ; its tiles at 0
    lda #(SPRITES >> 13)        ; sprites 8 x 8, their tiles at SPRITES
    sta OBJSEL
    lda #$11                    ; on the screen: background 1 and the sprites
    sta TM

    jsr spc_upload

    lda #$81                    ; the frame interrupt, and the console reads the pads each frame
    sta NMITIMEN
    lda #$0F
    sta INIDISP                 ; the screen on
forever:
    wai
    bra forever

; the four colours, to wherever CGADD points
colours:
    ldx #$0000
:   lda palette,x
    sta CGDATA
    inx
    cpx #8
    bne :-
    rts

; X: a list of texts (where on the map, characters, 0), ended by $FFFF
print_table:
    rep #$20
.a16
    lda a:$0000,x
    cmp #$FFFF
    beq @done
    sta VMADDL
    sep #$20
.a8
    inx
    inx
@char:
    lda a:$0000,x
    inx
    cmp #0
    beq print_table
    sta VMDATAL
    stz VMDATAH
    bra @char
@done:
    sep #$20
    rts

; The sound chip's program into its memory, and started. The chip's processor waits for it after power-on:
; it says $AA and $BB on ports 0 and 1, takes an address and then byte after byte, answering each with the
; count it came with. A chip that does not answer is given up on (the game is then silent).
spc_upload:
    ldx #$0000
@ready:
    dex
    beq @fail
    lda APUIO0
    cmp #$AA
    bne @ready
    lda APUIO1
    cmp #$BB
    bne @ready
    lda #$01                    ; bytes follow,
    sta APUIO1
    lda #<SPC_BASE              ; for this address
    sta APUIO2
    lda #>SPC_BASE
    sta APUIO3
    lda #$CC
    sta APUIO0
    ldx #$0000
@ack:
    dex
    beq @fail
    cmp APUIO0
    bne @ack
    ldy #$0000
@byte:
    lda spc,y
    sta APUIO1
    tya                         ; the count: the low byte of how many went before
    sta APUIO0
    ldx #$0000
@echo:
    dex
    beq @fail
    cmp APUIO0
    bne @echo
    iny
    cpy #SPC_SIZE
    bne @byte
    stz APUIO1                  ; no more bytes: run it,
    lda #<SPC_BASE              ; from here
    sta APUIO2
    lda #>SPC_BASE
    sta APUIO3
    tya
    clc
    adc #2                      ; (a count two on is "the end")
    sta APUIO0
    ldx #$0000
@gone:
    dex
    beq @fail
    cmp APUIO0
    bne @gone
@fail:
    stz APUIO0                  ; quiet (the program waits for this 0 before it listens)
    rts

; ---------- every frame, while the picture is not being drawn ----------
nmi:
    rep #$30
.a16
    pha
    phx
    phy
    phd
    phb
    lda #$0000
    tcd
    sep #$20
.a8
    phk
    plb
    lda RDNMI                   ; (the interrupt is taken)

    ; what the last frame found, onto the map: each button's light and count
    lda #$80
    sta VMAIN
    ldx #$0000
    ldy #$0000
@show:
    rep #$20
.a16
    lda lights,x
    sta VMADDL
    lda pad
    and masks,x
    sep #$20
.a8
    beq @dark
    lda #LIT
    bra @light
@dark:
    lda #' '
@light:
    sta VMDATAL
    stz VMDATAH
    rep #$20
.a16
    lda lights,x
    clc
    adc #3
    sta VMADDL
    sep #$20
.a8
    lda count,y
    clc
    adc #'0'
    sta VMDATAL
    stz VMDATAH
    lda count+1,y
    clc
    adc #'0'
    sta VMDATAL
    stz VMDATAH
    lda count+2,y
    clc
    adc #'0'
    sta VMDATAL
    stz VMDATAH
    iny
    iny
    iny
    inx
    inx
    cpx #24
    bne @show

    ; the clock: 00:00.0
    ldx #(MAP + TIMEROW * 32 + 15)
    stx VMADDL
    lda time
    jsr digit
    lda time+1
    jsr digit
    lda #':'
    sta VMDATAL
    stz VMDATAH
    lda time+2
    jsr digit
    lda time+3
    jsr digit
    lda #'.'
    sta VMDATAL
    stz VMDATAH
    lda time+4
    jsr digit

    ; the ball
    stz OAMADDL
    stz OAMADDH
    lda ballx
    sta OAMDATA
    lda #(BALLROW * 8 - 1)      ; (a sprite is drawn a line below where it is put)
    sta OAMDATA
    stz OAMDATA                 ; its tile
    lda #$30                    ; in front of the background
    sta OAMDATA

    ; the pad, once the console has read it
:   lda HVBJOY
    and #$01
    bne :-
    rep #$20
.a16
    lda pad
    sta was
    lda JOY1L
    and #$FFF0
    sta pad
    eor was
    and pad
    sta new
    sep #$20
.a8

    ; a button pressed since the last frame counts one more
    ldx #$0000
    ldy #$0000
@count:
    rep #$20
.a16
    lda new
    and masks,x
    sep #$20
.a8
    beq @next
    lda count+2,y
    inc a
    cmp #10
    bcc @ones
    lda #0
    sta count+2,y
    lda count+1,y
    inc a
    cmp #10
    bcc @tens
    lda #0
    sta count+1,y
    lda count,y
    inc a
    cmp #10
    bcc @hundreds
    lda #0
@hundreds:
    sta count,y
    bra @next
@tens:
    sta count+1,y
    bra @next
@ones:
    sta count+2,y
@next:
    iny
    iny
    iny
    inx
    inx
    cpx #24
    bne @count

    ; the clock: six frames are a tenth of a second
    inc tick
    lda tick
    cmp #6
    bcc @clocked
    stz tick
    ldx #$0004
@digit:
    lda time,x
    inc a
    cmp limits,x
    bcc @keep
    stz time,x
    cpx #$0004
    bne @carry
    lda #BEEPLEN                ; the tenths are at 0 again: a second begins
    sta beep
@carry:
    dex
    bpl @digit
    bra @clocked
@keep:
    sta time,x
@clocked:

    ; the ball: a pixel a frame, there and back
    lda ballback
    bne @left
    inc ballx
    lda ballx
    cmp #240
    bcc @balled
    inc ballback
    bra @balled
@left:
    dec ballx
    lda ballx
    cmp #9
    bcs @balled
    stz ballback
@balled:

    ; the sound: the second's beep, or the hum of a held button, or nothing
    lda beep
    beq @hum
    dec beep
    lda #BEEP
    bra @say
@hum:
    rep #$20
.a16
    lda pad
    sep #$20
.a8
    beq @quiet
    lda #TONE
    bra @say
@quiet:
    lda #0
@say:
    cmp sndcmd
    beq @said
    sta sndcmd
    sta APUIO0
@said:

    rep #$30
.a16
    plb
    pld
    ply
    plx
    pla
    rti

.a8
; A: a digit, onto the map where VMADDL points
digit:
    clc
    adc #'0'
    sta VMDATAL
    stz VMDATAH
    rts

nothing:
    rti

.segment "HEADER"
    .byte "SNES IDRIVE PAD TEST "       ; the cartridge's name, 21 characters
    .byte $20                           ; LoROM
    .byte $00                           ; ROM alone
    .byte $07                           ; 128 KB
    .byte $00                           ; no memory of its own
    .byte $01                           ; North America: 60 frames a second
    .byte $00, $00                      ; no maker, version 0
    .word $FFFF, $0000                  ; the checksum's complement and the checksum (games/build.js fills them in)

.segment "VECTORS"
    ; the 65816's own:  -, -, COP, BRK, ABORT, NMI, -, IRQ
    .word 0, 0, nothing, nothing, nothing, nmi, 0, nothing
    ; as a 6502:        -, -, COP, -, ABORT, NMI, RESET, IRQ
    .word 0, 0, nothing, 0, nothing, nothing, reset, nothing
