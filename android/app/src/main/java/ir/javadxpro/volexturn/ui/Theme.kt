package ir.javadxpro.volexturn.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Primary = Color(0xFF6366F1)
val PrimaryLight = Color(0xFF818CF8)
val Accent = Color(0xFFA855F7)
val BgDark = Color(0xFF070A12)
val SurfaceDark = Color(0xFF11151F)
val TextDark = Color(0xFFE8EAF0)

private val Dark = darkColorScheme(
    primary = Primary, secondary = Accent, background = BgDark,
    surface = SurfaceDark, onBackground = TextDark, onSurface = TextDark
)
private val Light = lightColorScheme(
    primary = Primary, secondary = Accent,
    background = Color(0xFFF6F7FB), surface = Color(0xFFFFFFFF)
)

private val AppTypography = Typography(
    /* وزیرمتن را می‌شود با res/font اضافه کرد؛ اینجا فونت پیش‌فرض سیستم است */
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 15.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontSize = 13.5.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 19.sp, fontWeight = FontWeight.ExtraBold),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 13.sp, fontWeight = FontWeight.Bold)
)

@Composable
fun VolexturnTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        typography = AppTypography,
        content = content
    )
}
