def sapa_tamu():
    tamu = ['Andi', 'Budi', 'Citra']
    hasil = []
    for nama in tamu:
        hasil.append(f'Halo {nama}, selamat datang!')
    return hasil
    
assert sapa_tamu() == ['Halo Andi, selamat datang!', 'Halo Budi, selamat datang!', 'Halo Citra, selamat datang!']
assert len(sapa_tamu()) == 3
assert all('Halo' in x for x in sapa_tamu())