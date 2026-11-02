CREATE VIEW [dbo].[VCN_TCNMPdtCstPointAmt]
AS
SELECT     Cst.FTCstCode, Cst.FCCstRetPoint + ISNULL(CstPoint.FNPntPoint, 0) AS FNPntPoint, Cst.FCCstRetAmt + ISNULL(CstPoint.FCPntAmtRcv, 0)
                      AS FCPntAmtRcv
FROM         dbo.TCNMCst AS Cst LEFT OUTER JOIN
                          (SELECT     FTCstCode, SUM(CASE FTPntCardType WHEN '1' THEN FNPntPoint WHEN '2' THEN (- 1) * FNPntPoint END) AS FNPntPoint,
                                                   SUM(CASE FTPntCardType WHEN '1' THEN FCPntAmtRcv WHEN '2' THEN (- 1) * FCPntAmtRcv END) AS FCPntAmtRcv
                            FROM          dbo.TCNTCstPoint
                            WHERE      (FTPntExpired = 'N') AND (FTPntStaPrcDoc = 'N')
                            GROUP BY FTCstCode) AS CstPoint ON Cst.FTCstCode = CstPoint.FTCstCode
